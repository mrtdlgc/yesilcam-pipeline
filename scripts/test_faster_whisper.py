#!/usr/bin/env python3
"""
Test Faster-Whisper with Demucs-processed audio files

Finds already processed demucs wav files from temp directory
and transcribes them using faster-whisper with CUDA.

Usage:
    python scripts/test_faster_whisper.py                     # Transcribe first 3 chunks
    python scripts/test_faster_whisper.py --all               # Transcribe all chunks
    python scripts/test_faster_whisper.py --limit 10          # Transcribe first 10 chunks
    python scripts/test_faster_whisper.py --chunk 5           # Transcribe specific chunk number
    python scripts/test_faster_whisper.py --list              # List available chunks
"""

import argparse
import glob
import json
import os
import re
import sys
import time
from pathlib import Path

# Add parent directory to path for config import
sys.path.insert(0, str(Path(__file__).parent.parent))


def find_demucs_files(temp_dir='./temp'):
    """Find all demucs-processed vocal wav files in temp directory"""
    pattern = os.path.join(temp_dir, '*_demucs', '*_vocals.wav')
    files = glob.glob(pattern)

    # Sort by chunk number
    def get_chunk_num(f):
        match = re.search(r'chunk_(\d+)_vocals\.wav$', f)
        return int(match.group(1)) if match else 0

    files.sort(key=get_chunk_num)
    return files


def get_file_duration(file_path):
    """Get audio file duration using ffprobe"""
    import subprocess
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file_path
        ], capture_output=True, text=True, timeout=10)
        return float(result.stdout.strip())
    except:
        return 0.0


def transcribe_with_faster_whisper(audio_file, model, language='tr', prompt=None):
    """Transcribe a single file using the loaded model"""

    transcribe_opts = {
        'language': language,
        'task': 'transcribe',
        'beam_size': 5,
        'best_of': 5,
        'patience': 1.0,
        'length_penalty': 1.0,
        'temperature': [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        'compression_ratio_threshold': 2.4,
        'log_prob_threshold': -1.0,
        'no_speech_threshold': 0.6,
        'condition_on_previous_text': True,
        'word_timestamps': False,
        'vad_filter': True,
        'vad_parameters': {
            'min_silence_duration_ms': 500,
            'speech_pad_ms': 200
        }
    }

    if prompt:
        transcribe_opts['initial_prompt'] = prompt

    start_time = time.time()
    segments_iter, info = model.transcribe(audio_file, **transcribe_opts)

    segments = []
    for seg in segments_iter:
        segments.append({
            'id': seg.id,
            'text': seg.text.strip(),
            'start': round(seg.start, 3),
            'end': round(seg.end, 3),
            'no_speech_prob': round(seg.no_speech_prob, 3),
            'avg_logprob': round(seg.avg_logprob, 3),
            'compression_ratio': round(seg.compression_ratio, 3)
        })

    elapsed = time.time() - start_time

    return {
        'text': ' '.join(seg['text'] for seg in segments if seg['text']),
        'segments': segments,
        'language': info.language,
        'duration': round(info.duration, 2),
        'elapsed': round(elapsed, 2),
        'realtime_factor': round(info.duration / elapsed, 2) if elapsed > 0 else 0
    }


def main():
    parser = argparse.ArgumentParser(description='Test Faster-Whisper with Demucs files')
    parser.add_argument('--temp-dir', default='./temp', help='Temp directory with demucs files')
    parser.add_argument('--list', action='store_true', help='List available chunk files')
    parser.add_argument('--all', action='store_true', help='Transcribe all chunks')
    parser.add_argument('--limit', type=int, default=3, help='Number of chunks to transcribe (default: 3)')
    parser.add_argument('--chunk', type=int, help='Transcribe specific chunk number')
    parser.add_argument('--model', default='large-v3', help='Whisper model (default: large-v3)')
    parser.add_argument('--device', default='cuda', choices=['cpu', 'cuda'], help='Device (default: cuda)')
    parser.add_argument('--compute-type', default='float16', help='Compute type (default: float16 for GPU)')
    parser.add_argument('--language', default='tr', help='Language code (default: tr)')
    parser.add_argument('--output', '-o', help='Output JSON file')
    parser.add_argument('--quiet', '-q', action='store_true', help='Minimal output')

    args = parser.parse_args()

    # Find demucs files
    files = find_demucs_files(args.temp_dir)

    if not files:
        print(f"No demucs wav files found in {args.temp_dir}")
        print(f"Looking for pattern: {args.temp_dir}/*_demucs/*_vocals.wav")
        sys.exit(1)

    print(f"Found {len(files)} demucs-processed audio files")
    print()

    # List mode
    if args.list:
        print("Available chunks:")
        for i, f in enumerate(files):
            duration = get_file_duration(f)
            print(f"  {i+1:3d}. {os.path.basename(f)} ({duration:.1f}s)")
        sys.exit(0)

    # Filter files based on args
    if args.chunk is not None:
        # Find specific chunk
        chunk_pattern = f'chunk_{args.chunk}_vocals.wav'
        files = [f for f in files if chunk_pattern in f]
        if not files:
            print(f"Chunk {args.chunk} not found")
            sys.exit(1)
    elif not args.all:
        files = files[:args.limit]

    print(f"Will transcribe {len(files)} file(s)")
    print()

    # Load faster-whisper
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERROR: faster-whisper not installed")
        print("Install with: pip install faster-whisper")
        sys.exit(1)

    # Check CUDA availability
    if args.device == 'cuda':
        try:
            import torch
            if not torch.cuda.is_available():
                print("WARNING: CUDA not available, falling back to CPU")
                args.device = 'cpu'
                args.compute_type = 'int8'
            else:
                print(f"CUDA available: {torch.cuda.get_device_name(0)}")
                # Check for CUDA library compatibility
                try:
                    import ctranslate2
                    # Try to detect if CUDA libs are compatible
                    cuda_version = torch.version.cuda
                    print(f"PyTorch CUDA version: {cuda_version}")
                except Exception as e:
                    print(f"Note: {e}")
        except ImportError:
            print("WARNING: PyTorch not available for CUDA check, trying anyway...")

    # Adjust compute type for CPU
    if args.device == 'cpu' and args.compute_type == 'float16':
        args.compute_type = 'int8'
        print("Note: Using int8 for CPU (float16 requires GPU)")

    print()
    print("=" * 60)
    print("LOADING MODEL")
    print("=" * 60)
    print(f"  Model: {args.model}")
    print(f"  Device: {args.device}")
    print(f"  Compute type: {args.compute_type}")
    print()

    load_start = time.time()
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type
        )
    except Exception as e:
        error_msg = str(e)
        if 'cublas' in error_msg.lower() or 'cuda' in error_msg.lower():
            print(f"\nCUDA ERROR: {e}")
            print("\nThis usually means CUDA library version mismatch.")
            print("faster-whisper/CTranslate2 requires CUDA 12.x libraries.")
            print("\nFalling back to CPU mode...")
            args.device = 'cpu'
            args.compute_type = 'int8'
            model = WhisperModel(
                args.model,
                device=args.device,
                compute_type=args.compute_type
            )
        else:
            raise

    load_time = time.time() - load_start
    print(f"Model loaded in {load_time:.1f}s (device: {args.device})")
    print()

    # Transcribe files
    results = []
    total_audio_duration = 0
    total_transcribe_time = 0

    print("=" * 60)
    print("TRANSCRIBING")
    print("=" * 60)

    for i, file_path in enumerate(files):
        filename = os.path.basename(file_path)

        if not args.quiet:
            print(f"\n[{i+1}/{len(files)}] {filename}")

        try:
            result = transcribe_with_faster_whisper(
                file_path,
                model,
                language=args.language
            )

            results.append({
                'file': filename,
                'path': file_path,
                **result
            })

            total_audio_duration += result['duration']
            total_transcribe_time += result['elapsed']

            if not args.quiet:
                print(f"  Duration: {result['duration']:.1f}s")
                print(f"  Time: {result['elapsed']:.1f}s ({result['realtime_factor']}x realtime)")
                print(f"  Segments: {len(result['segments'])}")
                if result['text']:
                    preview = result['text'][:100]
                    if len(result['text']) > 100:
                        preview += '...'
                    print(f"  Text: {preview}")
            else:
                print(f"  {filename}: {result['duration']:.1f}s -> {result['elapsed']:.1f}s ({result['realtime_factor']}x)")

        except Exception as e:
            print(f"  ERROR: {e}")
            results.append({
                'file': filename,
                'path': file_path,
                'error': str(e)
            })

    # Summary
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Files processed: {len(files)}")
    print(f"  Total audio: {total_audio_duration:.1f}s ({total_audio_duration/60:.1f} min)")
    print(f"  Total time: {total_transcribe_time:.1f}s ({total_transcribe_time/60:.1f} min)")
    if total_transcribe_time > 0:
        overall_rtf = total_audio_duration / total_transcribe_time
        print(f"  Overall realtime factor: {overall_rtf:.2f}x")
    print(f"  Model load time: {load_time:.1f}s")

    # Save output
    if args.output:
        output_data = {
            'config': {
                'model': args.model,
                'device': args.device,
                'compute_type': args.compute_type,
                'language': args.language
            },
            'stats': {
                'files_processed': len(files),
                'total_audio_seconds': round(total_audio_duration, 2),
                'total_transcribe_seconds': round(total_transcribe_time, 2),
                'model_load_seconds': round(load_time, 2),
                'overall_realtime_factor': round(total_audio_duration / total_transcribe_time, 2) if total_transcribe_time > 0 else 0
            },
            'results': results
        }

        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)
        print(f"\nResults saved to: {args.output}")

    # Print all transcriptions at the end if not quiet
    if not args.quiet and len(results) > 0:
        print()
        print("=" * 60)
        print("TRANSCRIPTIONS")
        print("=" * 60)
        for r in results:
            if 'error' not in r and r.get('text'):
                print(f"\n[{r['file']}]")
                print(r['text'])


if __name__ == '__main__':
    main()
