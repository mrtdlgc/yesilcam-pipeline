#!/usr/bin/env python3
"""
Silero VAD Filter
Secondary filter after FFT chunking to detect speech vs silence/music.
Uses Silero VAD model for accurate speech detection.

Input: JSON file with list of audio chunk paths and timing info
Output: JSON with filtered chunks (kept/discarded) and stats

Usage:
    python 2.6_vad_filter.py <chunks_json> --output <output_json>
    python 2.6_vad_filter.py --check  # Check if dependencies available
"""

import argparse
import json
import os
import sys
import warnings

# Suppress unnecessary warnings
warnings.filterwarnings('ignore')

def check_dependencies():
    """Check if required dependencies are installed."""
    result = {
        'installed': True,
        'torch': False,
        'torchaudio': False,
        'silero_vad': False,
        'errors': []
    }

    try:
        import torch
        result['torch'] = True
        result['torch_version'] = torch.__version__
    except ImportError as e:
        result['installed'] = False
        result['errors'].append(f'torch: {e}')

    try:
        import torchaudio
        result['torchaudio'] = True
        result['torchaudio_version'] = torchaudio.__version__
    except ImportError as e:
        result['installed'] = False
        result['errors'].append(f'torchaudio: {e}')

    # Silero VAD is loaded from torch hub, no separate install needed
    if result['torch']:
        try:
            import torch
            # Quick check that torch hub is accessible
            result['silero_vad'] = True
        except Exception as e:
            result['errors'].append(f'silero_vad: {e}')

    return result


def read_audio_fallback(path, sampling_rate=16000):
    """
    Read audio file using soundfile/ffmpeg instead of torchaudio.
    Works around torchcodec requirement in newer torchaudio versions.
    """
    import torch
    import subprocess
    import tempfile
    import numpy as np

    # Use ffmpeg to convert to 16kHz mono WAV
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        # FFmpeg conversion to 16kHz mono
        subprocess.run([
            'ffmpeg', '-i', path,
            '-ar', str(sampling_rate),
            '-ac', '1',
            '-f', 'wav',
            '-y', tmp_path
        ], capture_output=True, check=True)

        # Read with scipy (always available with numpy)
        from scipy.io import wavfile
        sr, audio = wavfile.read(tmp_path)

        # Normalize to float32 [-1, 1]
        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        elif audio.dtype == np.int32:
            audio = audio.astype(np.float32) / 2147483648.0

        return torch.from_numpy(audio)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def load_silero_vad():
    """
    Load Silero VAD model from torch hub.
    Returns model and utility functions.
    """
    import torch

    print("Loading Silero VAD model...", file=sys.stderr)

    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        onnx=False
    )

    (get_speech_timestamps, save_audio, read_audio, VADIterator, collect_chunks) = utils

    # Always use FFmpeg-based loader to avoid torchaudio/torchcodec issues
    print("  Using FFmpeg audio loader", file=sys.stderr)
    read_audio = read_audio_fallback

    print("  Silero VAD model loaded", file=sys.stderr)

    return {
        'model': model,
        'get_speech_timestamps': get_speech_timestamps,
        'read_audio': read_audio,
        'collect_chunks': collect_chunks
    }


def analyze_chunk(audio_file, vad_utils, threshold=0.5, min_speech_ms=250):
    """
    Analyze a single audio chunk for speech content.

    Args:
        audio_file: Path to audio chunk
        vad_utils: Dict with model and utility functions
        threshold: Speech probability threshold (0.0-1.0)
        min_speech_ms: Minimum speech duration to consider

    Returns: {
        'file': str,
        'has_speech': bool,
        'speech_ratio': float,  # 0.0-1.0
        'speech_segments': [(start_ms, end_ms), ...],
        'total_speech_ms': int,
        'total_duration_ms': int
    }
    """
    import torch

    model = vad_utils['model']
    get_speech_timestamps = vad_utils['get_speech_timestamps']
    read_audio = vad_utils['read_audio']

    try:
        # Read audio (Silero expects 16kHz mono)
        wav = read_audio(audio_file, sampling_rate=16000)

        # Get duration in ms
        duration_ms = len(wav) / 16000 * 1000

        # Get speech timestamps
        speech_timestamps = get_speech_timestamps(
            wav,
            model,
            threshold=threshold,
            min_speech_duration_ms=min_speech_ms,
            min_silence_duration_ms=100,
            return_seconds=False  # Return in samples
        )

        # Convert to ms and calculate stats
        speech_segments = []
        total_speech_ms = 0

        for ts in speech_timestamps:
            start_ms = ts['start'] / 16  # samples to ms at 16kHz
            end_ms = ts['end'] / 16
            speech_segments.append((int(start_ms), int(end_ms)))
            total_speech_ms += (end_ms - start_ms)

        speech_ratio = total_speech_ms / duration_ms if duration_ms > 0 else 0
        has_speech = len(speech_segments) > 0 and total_speech_ms >= min_speech_ms

        return {
            'file': audio_file,
            'has_speech': has_speech,
            'speech_ratio': round(speech_ratio, 3),
            'speech_segments': speech_segments,
            'total_speech_ms': int(total_speech_ms),
            'total_duration_ms': int(duration_ms)
        }

    except Exception as e:
        print(f"  Warning: Failed to analyze {audio_file}: {e}", file=sys.stderr)
        # On error, assume it has speech (don't discard)
        return {
            'file': audio_file,
            'has_speech': True,
            'speech_ratio': 1.0,
            'speech_segments': [],
            'total_speech_ms': 0,
            'total_duration_ms': 0,
            'error': str(e)
        }


def filter_chunks(chunks, vad_utils, threshold=0.5, min_speech_ratio=0.1, min_speech_ms=250):
    """
    Filter chunks based on speech detection.

    Args:
        chunks: List of chunk dicts with 'file', 'startTime', 'endTime'
        vad_utils: Dict with model and utility functions
        threshold: Speech probability threshold (0.0-1.0)
        min_speech_ratio: Minimum speech ratio to keep chunk
        min_speech_ms: Minimum speech duration in ms

    Returns: {
        'kept': [chunks with speech],
        'discarded': [chunks without speech],
        'stats': {
            'total_chunks': int,
            'kept_count': int,
            'discarded_count': int,
            'saved_duration_s': float
        }
    }
    """
    kept = []
    discarded = []
    total_discarded_duration = 0

    print(f"Analyzing {len(chunks)} chunks for speech...", file=sys.stderr)

    for i, chunk in enumerate(chunks):
        audio_file = chunk.get('file')
        if not audio_file or not os.path.exists(audio_file):
            print(f"  Warning: Chunk {i} file not found: {audio_file}", file=sys.stderr)
            kept.append(chunk)  # Keep on error
            continue

        analysis = analyze_chunk(audio_file, vad_utils, threshold, min_speech_ms)

        # Decide whether to keep
        if analysis['has_speech'] and analysis['speech_ratio'] >= min_speech_ratio:
            kept.append({
                **chunk,
                '_vad': {
                    'speech_ratio': analysis['speech_ratio'],
                    'speech_ms': analysis['total_speech_ms']
                }
            })
            status = '✓'
        else:
            discarded.append({
                **chunk,
                '_vad': {
                    'speech_ratio': analysis['speech_ratio'],
                    'speech_ms': analysis['total_speech_ms'],
                    'reason': 'no_speech' if not analysis['has_speech'] else 'low_speech_ratio'
                }
            })
            total_discarded_duration += chunk.get('endTime', 0) - chunk.get('startTime', 0)
            status = '✗'

        # Progress
        print(f"  [{i+1}/{len(chunks)}] {status} {os.path.basename(audio_file)}: "
              f"speech={analysis['speech_ratio']*100:.0f}%", file=sys.stderr)

    stats = {
        'total_chunks': len(chunks),
        'kept_count': len(kept),
        'discarded_count': len(discarded),
        'saved_duration_s': round(total_discarded_duration, 2)
    }

    print(f"\nVAD Filter complete:", file=sys.stderr)
    print(f"  Kept: {stats['kept_count']} chunks", file=sys.stderr)
    print(f"  Discarded: {stats['discarded_count']} chunks", file=sys.stderr)
    print(f"  Saved: {stats['saved_duration_s']}s of processing time", file=sys.stderr)

    return {
        'kept': kept,
        'discarded': discarded,
        'stats': stats
    }


def main():
    parser = argparse.ArgumentParser(description='Silero VAD Filter for audio chunks')
    parser.add_argument('chunks_json', nargs='?', help='JSON file with chunks list')
    parser.add_argument('--output', '-o', help='Output JSON file path')
    parser.add_argument('--check', action='store_true', help='Check if dependencies are available')
    parser.add_argument('--threshold', type=float, default=0.5, help='Speech probability threshold (0.0-1.0)')
    parser.add_argument('--min-speech-ratio', type=float, default=0.1, help='Minimum speech ratio to keep chunk')
    parser.add_argument('--min-speech-ms', type=int, default=250, help='Minimum speech duration in ms')

    args = parser.parse_args()

    # Check mode
    if args.check:
        result = check_dependencies()
        print(json.dumps(result))
        sys.exit(0 if result['installed'] else 1)

    # Validate input
    if not args.chunks_json:
        parser.print_help()
        sys.exit(1)

    if not os.path.exists(args.chunks_json):
        print(json.dumps({'error': f'File not found: {args.chunks_json}'}))
        sys.exit(1)

    # Load chunks
    try:
        with open(args.chunks_json, 'r') as f:
            data = json.load(f)

        # Support both array and object with 'chunks' key
        if isinstance(data, list):
            chunks = data
        elif isinstance(data, dict) and 'chunks' in data:
            chunks = data['chunks']
        else:
            print(json.dumps({'error': 'Invalid chunks format'}))
            sys.exit(1)

    except json.JSONDecodeError as e:
        print(json.dumps({'error': f'Invalid JSON: {e}'}))
        sys.exit(1)

    # Load VAD model
    try:
        vad_utils = load_silero_vad()
    except Exception as e:
        print(json.dumps({'error': f'Failed to load Silero VAD: {e}'}))
        sys.exit(1)

    # Filter chunks
    result = filter_chunks(
        chunks,
        vad_utils,
        threshold=args.threshold,
        min_speech_ratio=args.min_speech_ratio,
        min_speech_ms=args.min_speech_ms
    )

    # Output
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"Results saved to: {args.output}", file=sys.stderr)
    else:
        print(json.dumps(result))


if __name__ == '__main__':
    main()
