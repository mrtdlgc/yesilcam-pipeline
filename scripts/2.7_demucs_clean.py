#!/usr/bin/env python3
"""Separate chunks sequentially with one model; retain floating point vocals."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def progress(done, total, detail):
    print('YESILCAM_PROGRESS ' + json.dumps({'completed': done, 'total': total, 'detail': detail}), file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio_file', nargs='?')
    parser.add_argument('--batch')
    parser.add_argument('--output')
    parser.add_argument('--model', default='htdemucs_ft')
    parser.add_argument('--device', default='cuda')
    parser.add_argument('--shifts', type=int, default=0)
    parser.add_argument('--overlap', type=float, default=0.25)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    import torch
    import numpy as np
    from scipy.io import wavfile
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    if args.check:
        print(json.dumps({'installed': True, 'cuda_available': torch.cuda.is_available()}))
        return
    if not args.output or not (args.batch or args.audio_file):
        parser.error('Provide input and --output')
    if not 0 <= args.overlap < 1 or args.shifts < 0:
        parser.error('Invalid shifts or overlap')
    torch.set_num_threads(max(1, int(os.getenv('OMP_NUM_THREADS', '2'))))
    device = args.device
    if device == 'cuda' and not torch.cuda.is_available():
        print('CUDA unavailable; Demucs is using CPU.', file=sys.stderr)
        device = 'cpu'
    # Keep a bag's weights on CPU. apply_model moves one submodel at a time to
    # the GPU and returns it to CPU, instead of occupying VRAM with all four.
    model = get_model(args.model).eval()
    vocal_index = model.sources.index('vocals')
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(args.batch).read_text(encoding='utf-8')) if args.batch else [{'id': 0, 'file': args.audio_file}]
    chunks = data if isinstance(data, list) else data['chunks']
    result = []
    for index, chunk in enumerate(chunks):
        source = Path(chunk['file'])
        target = output / f'chunk_{int(chunk.get("id", index)):05d}_vocals.wav'
        metadata_file = target.with_suffix('.json')
        source_hash = hashlib.sha256()
        with source.open('rb') as source_handle:
            for block in iter(lambda: source_handle.read(1024 * 1024), b''):
                source_hash.update(block)
        identity = {'source_sha256': source_hash.hexdigest(), 'model': args.model,
                    'device': device, 'shifts': args.shifts, 'overlap': args.overlap}
        if target.exists() and metadata_file.exists():
            saved = json.loads(metadata_file.read_text(encoding='utf-8'))
            if saved.get('identity') == identity and saved.get('size') == target.stat().st_size:
                result.append({**chunk, 'file': str(target), '_original_file': str(source), '_demucs': identity})
                print(f'Reusing separated chunk {index + 1}/{len(chunks)}', file=sys.stderr, flush=True)
                progress(index + 1, len(chunks), f'Reused vocal chunk {index + 1}/{len(chunks)}')
                continue
        print(f'Separating {index + 1}/{len(chunks)}: {source.name}', file=sys.stderr, flush=True)
        progress(index, len(chunks), f'Separating chunk {index + 1}/{len(chunks)}')
        # Decode each bounded chunk directly at the model rate. No lossy intermediary.
        decoded = subprocess.run([
            'ffmpeg', '-v', 'error', '-nostdin', '-i', str(source), '-vn',
            '-ar', str(model.samplerate), '-ac', str(model.audio_channels),
            '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'
        ], capture_output=True, check=True, timeout=120)
        samples = np.frombuffer(decoded.stdout, dtype='<f4').copy()
        if not len(samples):
            raise ValueError(f'Empty audio: {source}')
        wav = torch.from_numpy(samples.reshape(-1, model.audio_channels).T.copy())
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std(unbiased=False)
        normalized = (wav - mean) / (std + 1e-8)
        with torch.inference_mode():
            sources = apply_model(model, normalized[None], device=device,
                                  shifts=args.shifts, overlap=args.overlap,
                                  split=True, progress=False, num_workers=0)
            vocals = sources[0, vocal_index].cpu() * (std + 1e-8) + mean
        if not torch.isfinite(vocals).all():
            raise ValueError('Demucs returned non-finite audio')
        temporary = target.with_suffix('.tmp.wav')
        wavfile.write(temporary, model.samplerate, vocals.T.numpy().astype(np.float32))
        temporary.replace(target)
        metadata_temp = metadata_file.with_suffix('.tmp.json')
        metadata_temp.write_text(json.dumps({'identity': identity, 'size': target.stat().st_size}), encoding='utf-8')
        metadata_temp.replace(metadata_file)
        progress(index + 1, len(chunks), f'Vocal chunk {index + 1}/{len(chunks)} saved')
        result.append({**chunk, 'file': str(target), '_original_file': str(source),
                       '_demucs': {'model': args.model, 'device': device,
                                   'shifts': args.shifts, 'overlap': args.overlap}})
        del sources, vocals, wav, normalized
    print(json.dumps({'chunks': result, 'stats': {'total': len(chunks), 'success': len(result)}}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Demucs failed: {exc}', file=sys.stderr)
        sys.exit(1)
