#!/usr/bin/env python3
"""
Silero VAD-based speech probability profile generator.
Creates frame-level speech probabilities for precise subtitle alignment.

Unlike energy-based detection (picks up music/noise), Silero VAD
specifically detects human speech using a neural network.

Output: JSON with frame-level speech probabilities
"""

import argparse
import json
import os
import sys
import warnings

warnings.filterwarnings('ignore')

SAMPLE_RATE = 16000
WINDOW_SIZE_SAMPLES = 512  # Silero's native chunk size for 16kHz


def load_silero_vad():
    """Load Silero VAD model."""
    import torch

    print("Loading Silero VAD model...", file=sys.stderr)

    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        onnx=False
    )

    print("  Model loaded", file=sys.stderr)
    return model


def read_audio_ffmpeg(path, sampling_rate=16000):
    """Read audio using FFmpeg (avoids torchaudio issues)."""
    import torch
    import subprocess
    import tempfile
    import numpy as np

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name

    try:
        subprocess.run([
            'ffmpeg', '-i', path,
            '-ar', str(sampling_rate),
            '-ac', '1',
            '-f', 'wav',
            '-y', tmp_path
        ], capture_output=True, check=True)

        from scipy.io import wavfile
        sr, audio = wavfile.read(tmp_path)

        if audio.dtype == np.int16:
            audio = audio.astype(np.float32) / 32768.0
        elif audio.dtype == np.int32:
            audio = audio.astype(np.float32) / 2147483648.0

        return torch.from_numpy(audio)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def build_speech_probability_profile(audio_file, model, window_ms=32):
    """
    Build frame-level speech probability profile.

    Args:
        audio_file: Path to audio file
        model: Silero VAD model
        window_ms: Window size in milliseconds (default 32ms = 512 samples at 16kHz)

    Returns:
        List of {time: float, prob: float} entries
    """
    import torch

    print(f"Reading audio: {audio_file}", file=sys.stderr)
    wav = read_audio_ffmpeg(audio_file, SAMPLE_RATE)

    duration = len(wav) / SAMPLE_RATE
    print(f"  Duration: {duration:.1f}s ({len(wav)} samples)", file=sys.stderr)

    # Reset model state
    model.reset_states()

    # Process in chunks matching Silero's native window size
    window_samples = int(SAMPLE_RATE * window_ms / 1000)

    # Silero works best with 512-sample chunks at 16kHz (32ms)
    # But we can use larger chunks for speed with slight accuracy loss
    chunk_size = 512  # Native Silero chunk size
    hop_size = 256    # 50% overlap for smoother profile

    profile = []
    total_chunks = (len(wav) - chunk_size) // hop_size + 1

    print(f"  Computing speech probabilities ({total_chunks} frames)...", file=sys.stderr)

    with torch.no_grad():
        for i in range(0, len(wav) - chunk_size, hop_size):
            chunk = wav[i:i + chunk_size]

            # Get speech probability for this chunk
            prob = model(chunk, SAMPLE_RATE).item()

            time = (i + chunk_size // 2) / SAMPLE_RATE  # Center of window
            profile.append({
                'time': round(time, 4),
                'prob': round(prob, 4)
            })

            if len(profile) % 5000 == 0:
                print(f"    Processed {len(profile)}/{total_chunks} frames...", file=sys.stderr)

    print(f"  Generated {len(profile)} probability frames", file=sys.stderr)

    # Compute stats
    probs = [p['prob'] for p in profile]
    speech_frames = sum(1 for p in probs if p > 0.5)

    print(f"  Speech ratio: {speech_frames/len(profile)*100:.1f}% (threshold=0.5)", file=sys.stderr)

    return profile


def main():
    parser = argparse.ArgumentParser(description='Generate speech probability profile using Silero VAD')
    parser.add_argument('audio_file', nargs='?', help='Path to audio file')
    parser.add_argument('--output', '-o', help='Output JSON file (default: stdout)')
    parser.add_argument('--check', action='store_true', help='Check if dependencies available')

    args = parser.parse_args()

    if args.check:
        try:
            import torch
            print(json.dumps({'installed': True, 'torch_version': torch.__version__}))
            sys.exit(0)
        except ImportError as e:
            print(json.dumps({'installed': False, 'error': str(e)}))
            sys.exit(1)

    if not args.audio_file:
        parser.print_help()
        sys.exit(1)

    if not os.path.exists(args.audio_file):
        print(json.dumps({'error': f'File not found: {args.audio_file}'}), file=sys.stderr)
        sys.exit(1)

    # Load model
    model = load_silero_vad()

    # Build profile
    profile = build_speech_probability_profile(args.audio_file, model)

    result = {
        'audio_file': args.audio_file,
        'sample_rate': SAMPLE_RATE,
        'frame_count': len(profile),
        'duration': profile[-1]['time'] if profile else 0,
        'profile': profile
    }

    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f)
        print(f"Saved to: {args.output}", file=sys.stderr)
    else:
        print(json.dumps(result))


if __name__ == '__main__':
    main()
