#!/usr/bin/env python3
"""
Demucs Audio Cleaning
Uses Demucs model to extract vocals track and remove background music/noise.
This improves Whisper transcription accuracy for films with heavy soundtracks.

Supported models:
- htdemucs: Default hybrid model
- htdemucs_ft: Fine-tuned, better quality but slower
- htdemucs_6s: 6-source separation
- mdx_extra: Alternative architecture

Usage:
    python 2.7_demucs_clean.py <audio_file> --output <output_dir>
    python 2.7_demucs_clean.py --batch <chunks_json> --output <output_dir>
    python 2.7_demucs_clean.py --check  # Check if demucs is available
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Use the same Python interpreter that's running this script
PYTHON_CMD = sys.executable


def check_dependencies():
    """Check if Demucs is installed and available."""
    result = {
        'installed': False,
        'version': None,
        'cuda_available': False,
        'errors': []
    }

    try:
        # Check if demucs is importable
        import demucs
        result['installed'] = True
        result['version'] = getattr(demucs, '__version__', 'unknown')
    except ImportError as e:
        result['errors'].append(f'demucs not installed: {e}')
        return result

    # Check CUDA availability
    try:
        import torch
        result['cuda_available'] = torch.cuda.is_available()
        if result['cuda_available']:
            result['cuda_device'] = torch.cuda.get_device_name(0)
    except:
        pass

    # Verify demucs CLI is available
    try:
        proc = subprocess.run(
            [PYTHON_CMD, '-m', 'demucs', '--help'],
            capture_output=True,
            text=True,
            timeout=10
        )
        if proc.returncode != 0:
            result['errors'].append('demucs CLI not working')
    except Exception as e:
        result['errors'].append(f'demucs CLI error: {e}')

    return result


def save_audio_scipy(tensor, path, samplerate):
    """Save audio tensor using scipy instead of torchaudio (avoids torchcodec issues)."""
    import numpy as np
    from scipy.io import wavfile

    # Convert tensor to numpy
    audio = tensor.cpu().numpy()

    # Handle stereo/mono
    if audio.ndim == 2:
        audio = audio.T  # scipy expects (samples, channels)

    # Convert to int16
    audio = np.clip(audio, -1.0, 1.0)
    audio = (audio * 32767).astype(np.int16)

    wavfile.write(path, samplerate, audio)


def separate_vocals(
    audio_file,
    output_dir,
    model_name='htdemucs_ft',
    device='cpu',
    shifts=1
):
    """
    Extract vocals from audio file using Demucs API directly.
    Saves output with scipy to avoid torchaudio/torchcodec issues.

    Args:
        audio_file: Input audio path
        output_dir: Directory to save output
        model_name: Demucs model name
        device: 'cpu' or 'cuda'
        shifts: Number of shifts for better quality (1-5)

    Returns: Path to extracted vocals file
    """
    import torch

    audio_path = Path(audio_file)
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    print(f"  Separating vocals from: {audio_path.name}", file=sys.stderr)

    try:
        # Import demucs components
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        # Load audio with ffmpeg (avoid torchaudio)
        import numpy as np
        from scipy.io import wavfile

        # Convert to wav first with ffmpeg
        temp_wav = output_path / f"_temp_{audio_path.stem}.wav"
        subprocess.run([
            'ffmpeg', '-i', str(audio_path),
            '-ar', '44100', '-ac', '2',
            '-f', 'wav', '-y', str(temp_wav)
        ], capture_output=True, check=True)

        # Read with scipy
        sr, audio = wavfile.read(str(temp_wav))
        os.unlink(str(temp_wav))

        # Convert to float tensor
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        elif audio.dtype == np.int32:
            audio = audio.astype(np.float32) / 2147483648.0

        # Shape: (channels, samples)
        if audio.ndim == 1:
            audio = np.stack([audio, audio])  # Mono to stereo
        else:
            audio = audio.T

        wav = torch.from_numpy(audio).float()

        # Load model
        model = get_model(model_name)
        model.to(device)
        model.eval()

        # Add batch dimension
        wav = wav.unsqueeze(0).to(device)

        # Apply model
        with torch.no_grad():
            sources = apply_model(model, wav, shifts=shifts, overlap=0.25)

        # Get vocals (find index in sources)
        vocals_idx = model.sources.index('vocals')
        vocals = sources[0, vocals_idx]  # Remove batch dim

        # Save with scipy
        final_path = output_path / f"{audio_path.stem}_vocals.wav"
        save_audio_scipy(vocals, str(final_path), model.samplerate)

        print(f"  ✓ Vocals extracted: {final_path.name}", file=sys.stderr)
        return str(final_path)

    except Exception as e:
        print(f"  Warning: Demucs error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return None


def process_chunks(chunks, output_dir, model='htdemucs_ft', device='cpu', shifts=1):
    """
    Process multiple audio chunks through Demucs.

    Args:
        chunks: List of chunk dicts with 'file' key
        output_dir: Directory for cleaned outputs
        model: Demucs model name
        device: 'cpu' or 'cuda'
        shifts: Number of shifts for quality

    Returns: {
        'chunks': Updated chunk list with cleaned file paths,
        'stats': Processing statistics
    }
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    processed_chunks = []
    stats = {
        'total': len(chunks),
        'success': 0,
        'failed': 0,
        'skipped': 0
    }

    print(f"Processing {len(chunks)} chunks with Demucs ({model})...", file=sys.stderr)

    for i, chunk in enumerate(chunks):
        audio_file = chunk.get('file')

        if not audio_file or not os.path.exists(audio_file):
            print(f"  [{i+1}/{len(chunks)}] Skipped: file not found", file=sys.stderr)
            processed_chunks.append(chunk)
            stats['skipped'] += 1
            continue

        print(f"  [{i+1}/{len(chunks)}] Processing: {os.path.basename(audio_file)}", file=sys.stderr)

        vocals_file = separate_vocals(
            audio_file,
            output_dir,
            model_name=model,
            device=device,
            shifts=shifts
        )

        if vocals_file and os.path.exists(vocals_file):
            # Update chunk with cleaned audio path
            processed_chunks.append({
                **chunk,
                'file': vocals_file,
                '_original_file': audio_file,
                '_demucs': {
                    'model': model,
                    'cleaned': True
                }
            })
            stats['success'] += 1
        else:
            # Keep original on failure
            processed_chunks.append({
                **chunk,
                '_demucs': {
                    'model': model,
                    'cleaned': False,
                    'error': 'separation_failed'
                }
            })
            stats['failed'] += 1

    print(f"\nDemucs processing complete:", file=sys.stderr)
    print(f"  Success: {stats['success']}", file=sys.stderr)
    print(f"  Failed: {stats['failed']}", file=sys.stderr)
    print(f"  Skipped: {stats['skipped']}", file=sys.stderr)

    return {
        'chunks': processed_chunks,
        'stats': stats
    }


def main():
    parser = argparse.ArgumentParser(description='Demucs Audio Cleaning')
    parser.add_argument('audio_file', nargs='?', help='Single audio file to process')
    parser.add_argument('--batch', help='JSON file with chunks list for batch processing')
    parser.add_argument('--output', '-o', required=False, help='Output directory')
    parser.add_argument('--check', action='store_true', help='Check if demucs is available')
    parser.add_argument('--model', default='htdemucs_ft', help='Demucs model (htdemucs, htdemucs_ft, mdx_extra)')
    parser.add_argument('--device', default='cpu', help='Device (cpu or cuda)')
    parser.add_argument('--shifts', type=int, default=1, help='Number of shifts for quality (1-5)')

    args = parser.parse_args()

    # Check mode
    if args.check:
        result = check_dependencies()
        print(json.dumps(result))
        sys.exit(0 if result['installed'] else 1)

    # Batch mode
    if args.batch:
        if not os.path.exists(args.batch):
            print(json.dumps({'error': f'File not found: {args.batch}'}))
            sys.exit(1)

        output_dir = args.output or './temp/demucs'

        with open(args.batch, 'r') as f:
            data = json.load(f)

        chunks = data if isinstance(data, list) else data.get('chunks', [])

        result = process_chunks(
            chunks,
            output_dir,
            model=args.model,
            device=args.device,
            shifts=args.shifts
        )

        # Output result
        if args.output:
            output_file = os.path.join(args.output, 'demucs_result.json')
            with open(output_file, 'w') as f:
                json.dump(result, f, indent=2)
            print(f"Results saved to: {output_file}", file=sys.stderr)

        print(json.dumps(result))
        sys.exit(0)

    # Single file mode
    if args.audio_file:
        if not os.path.exists(args.audio_file):
            print(json.dumps({'error': f'File not found: {args.audio_file}'}))
            sys.exit(1)

        output_dir = args.output or './temp/demucs'

        vocals_file = separate_vocals(
            args.audio_file,
            output_dir,
            model_name=args.model,
            device=args.device,
            shifts=args.shifts
        )

        if vocals_file:
            print(json.dumps({
                'success': True,
                'input': args.audio_file,
                'output': vocals_file
            }))
            sys.exit(0)
        else:
            print(json.dumps({
                'success': False,
                'input': args.audio_file,
                'error': 'separation_failed'
            }))
            sys.exit(1)

    parser.print_help()
    sys.exit(1)


if __name__ == '__main__':
    main()
