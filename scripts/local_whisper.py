#!/usr/bin/env python3
"""
Local Whisper v3 Large Transcription
Uses faster-whisper (CTranslate2) for efficient CPU inference

Resource Management:
- Uses all available CPU cores for maximum performance
- Uses int8 quantization for memory efficiency
- Designed for dedicated VPS environments

Usage:
  python scripts/local_whisper.py <audio_file> --language tr --output output.json

Install:
  pip install faster-whisper
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

def get_resource_limits():
    """Calculate resource limits (use all available CPUs)"""
    try:
        cpu_count = os.cpu_count() or 4
    except:
        cpu_count = 4

    # Use all CPUs (leave 1 for system if more than 4 cores)
    cpu_threads = cpu_count if cpu_count <= 4 else cpu_count - 1

    # Single worker using all CPU threads for maximum realtime factor
    num_workers = 1

    return {
        'cpu_threads': cpu_threads,
        'num_workers': num_workers,
        'total_cpus': cpu_count
    }

def transcribe_audio(audio_file, language='tr', model_size='large-v3', output_file=None, prompt=None):
    """
    Transcribe audio using faster-whisper with resource limits

    Returns dict with segments and metadata matching Groq API format
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERROR: faster-whisper not installed", file=sys.stderr)
        print("Install with: pip install faster-whisper", file=sys.stderr)
        sys.exit(1)

    limits = get_resource_limits()

    # Handle 'auto' language detection
    # When language is 'auto', don't pass language param - Whisper will auto-detect
    if language == 'auto':
        language = None

    print(f"Local Whisper Transcription", file=sys.stderr)
    print(f"  Model: {model_size}", file=sys.stderr)
    print(f"  CPU threads: {limits['cpu_threads']}/{limits['total_cpus']}", file=sys.stderr)
    print(f"  Workers: {limits['num_workers']}", file=sys.stderr)
    print(f"  Language: {language if language else 'auto-detect'}", file=sys.stderr)

    start_time = time.time()

    # Load model with resource limits
    # Using int8 for CPU efficiency (good balance of speed/quality)
    # download_root defaults to ~/.cache/huggingface/hub
    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",  # int8 for CPU efficiency
        cpu_threads=limits['cpu_threads'],
        num_workers=limits['num_workers']
    )

    load_time = time.time() - start_time
    print(f"  Model loaded in {load_time:.1f}s", file=sys.stderr)

    # Transcribe with detailed segments
    transcribe_start = time.time()

    # Build transcription options
    transcribe_opts = {
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
        'word_timestamps': False,  # Only segment-level for efficiency
        'vad_filter': True,  # Use VAD to skip silence
        'vad_parameters': {
            'min_silence_duration_ms': 500,
            'speech_pad_ms': 200
        }
    }

    # Only set language if specified (None = auto-detect)
    if language:
        transcribe_opts['language'] = language

    # Add prompt if provided (for context continuity)
    if prompt:
        transcribe_opts['initial_prompt'] = prompt
        print(f"  Using prompt: \"{prompt[:50]}{'...' if len(prompt) > 50 else ''}\"", file=sys.stderr)

    segments_iter, info = model.transcribe(audio_file, **transcribe_opts)

    # Convert to list and format like Groq API response
    segments = []
    for seg in segments_iter:
        segments.append({
            'id': seg.id,
            'text': seg.text.strip(),
            'start': seg.start,
            'end': seg.end,
            'seek': int(seg.seek) if hasattr(seg, 'seek') else 0,
            'no_speech_prob': seg.no_speech_prob,
            'avg_logprob': seg.avg_logprob,
            'compression_ratio': seg.compression_ratio,
            'temperature': seg.temperature if hasattr(seg, 'temperature') else 0.0
        })

    transcribe_time = time.time() - transcribe_start
    total_time = time.time() - start_time

    # Build response matching Groq API format
    response = {
        'text': ' '.join(seg['text'] for seg in segments),
        'segments': segments,
        'language': info.language,
        'duration': info.duration,
        '_local_whisper': {
            'model': model_size,
            'device': 'cpu',
            'compute_type': 'int8',
            'cpu_threads': limits['cpu_threads'],
            'load_time_s': round(load_time, 2),
            'transcribe_time_s': round(transcribe_time, 2),
            'total_time_s': round(total_time, 2),
            'realtime_factor': round(info.duration / transcribe_time, 2) if transcribe_time > 0 else 0
        }
    }

    print(f"  Transcribed {len(segments)} segments in {transcribe_time:.1f}s", file=sys.stderr)
    print(f"  Audio duration: {info.duration:.1f}s", file=sys.stderr)
    print(f"  Realtime factor: {response['_local_whisper']['realtime_factor']}x", file=sys.stderr)

    # Output JSON
    output_json = json.dumps(response, ensure_ascii=False, indent=2)

    if output_file:
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(output_json)
        print(f"  Saved to: {output_file}", file=sys.stderr)
    else:
        print(output_json)

    return response

def main():
    parser = argparse.ArgumentParser(description='Local Whisper v3 Large Transcription')
    parser.add_argument('audio_file', help='Path to audio file')
    parser.add_argument('--language', '-l', default='tr', help='Language code (default: tr)')
    parser.add_argument('--model', '-m', default='large-v3',
                       choices=['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3'],
                       help='Model size (default: large-v3)')
    parser.add_argument('--output', '-o', help='Output JSON file (default: stdout)')
    parser.add_argument('--prompt', '-p', help='Initial prompt for context')
    parser.add_argument('--check', action='store_true', help='Check if faster-whisper is installed')

    args = parser.parse_args()

    if args.check:
        try:
            import faster_whisper
            limits = get_resource_limits()
            print(json.dumps({
                'installed': True,
                'version': getattr(faster_whisper, '__version__', 'unknown'),
                'cpu_threads': limits['cpu_threads'],
                'total_cpus': limits['total_cpus'],
                'num_workers': limits['num_workers']
            }))
            sys.exit(0)
        except ImportError:
            print(json.dumps({'installed': False}))
            sys.exit(1)

    if not os.path.exists(args.audio_file):
        print(f"ERROR: Audio file not found: {args.audio_file}", file=sys.stderr)
        sys.exit(1)

    transcribe_audio(
        args.audio_file,
        language=args.language,
        model_size=args.model,
        output_file=args.output,
        prompt=args.prompt
    )

if __name__ == '__main__':
    main()
