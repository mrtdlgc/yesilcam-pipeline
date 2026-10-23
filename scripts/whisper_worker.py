#!/usr/bin/env python3
"""
Persistent Whisper Worker
Keeps the model loaded in memory and processes multiple files without reloading.

Communication via stdin/stdout:
- Input: JSON line with {file, language, prompt (optional)}
- Output: JSON line with transcription result
- Send {"command": "quit"} to exit

This eliminates the ~5 second model load time per chunk.
"""

import json
import os
import sys
import time
import io

# Fix Windows encoding for stdin/stdout (required for Cyrillic, etc.)
if sys.platform == 'win32':
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', newline='')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', newline='')

def get_resource_limits():
    """Calculate resource limits (use all available CPUs)"""
    try:
        cpu_count = os.cpu_count() or 4
    except:
        cpu_count = 4

    # Use all CPUs (leave 1 for system if more than 4 cores)
    cpu_threads = cpu_count if cpu_count <= 4 else cpu_count - 1

    return {
        'cpu_threads': cpu_threads,
        'num_workers': 1,  # Single worker for sequential processing
        'total_cpus': cpu_count
    }

def main():
    # Import and load model once at startup
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({'error': 'faster-whisper not installed'}), flush=True)
        sys.exit(1)

    limits = get_resource_limits()
    model_size = os.environ.get('WHISPER_MODEL', 'large-v3')
    device = os.environ.get('WHISPER_DEVICE', 'cpu')
    compute_type = os.environ.get('WHISPER_COMPUTE_TYPE', 'int8')

    print(f"Whisper Worker starting...", file=sys.stderr)
    print(f"  Model: {model_size}", file=sys.stderr)
    print(f"  Device: {device}", file=sys.stderr)
    print(f"  Compute type: {compute_type}", file=sys.stderr)
    print(f"  CPU threads: {limits['cpu_threads']}/{limits['total_cpus']}", file=sys.stderr)

    start_time = time.time()

    # Load model once - this is the expensive operation
    # Try CUDA first, fall back to CPU if it fails
    try:
        model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            cpu_threads=limits['cpu_threads'],
            num_workers=limits['num_workers']
        )
    except Exception as e:
        error_msg = str(e)
        if device == 'cuda' and ('cublas' in error_msg.lower() or 'cuda' in error_msg.lower()):
            print(f"  CUDA error: {e}", file=sys.stderr)
            print(f"  Falling back to CPU...", file=sys.stderr)
            device = 'cpu'
            compute_type = 'int8'
            model = WhisperModel(
                model_size,
                device=device,
                compute_type=compute_type,
                cpu_threads=limits['cpu_threads'],
                num_workers=limits['num_workers']
            )
        else:
            raise

    load_time = time.time() - start_time
    print(f"  Model loaded in {load_time:.1f}s (device: {device})", file=sys.stderr)

    # Signal ready
    print(json.dumps({'status': 'ready', 'load_time': round(load_time, 2)}), flush=True)

    # Process requests from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({'error': f'Invalid JSON: {e}'}), flush=True)
            continue

        # Check for quit command
        if request.get('command') == 'quit':
            print(json.dumps({'status': 'exiting'}), flush=True)
            break

        # Get transcription parameters
        audio_file = request.get('file')
        language = request.get('language', 'tr')
        prompt = request.get('prompt')

        # Handle 'auto' language detection
        # When language is 'auto', don't pass language param - Whisper will auto-detect
        if language == 'auto':
            language = None

        if not audio_file:
            print(json.dumps({'error': 'No file specified'}), flush=True)
            continue

        if not os.path.exists(audio_file):
            print(json.dumps({'error': f'File not found: {audio_file}'}), flush=True)
            continue

        # Transcribe
        transcribe_start = time.time()

        try:
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
                'word_timestamps': False,
                'vad_filter': True,
                'vad_parameters': {
                    'min_silence_duration_ms': 500,
                    'speech_pad_ms': 200
                }
            }

            # Only set language if specified (None = auto-detect)
            if language:
                transcribe_opts['language'] = language

            if prompt:
                # Truncate long prompts (Whisper has ~224 token limit)
                # Keep last 500 chars which is roughly ~125 tokens for Turkish
                if len(prompt) > 500:
                    prompt = prompt[-500:]
                transcribe_opts['initial_prompt'] = prompt

            segments_iter, info = model.transcribe(audio_file, **transcribe_opts)

            # Convert to list
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

            response = {
                'text': ' '.join(seg['text'] for seg in segments),
                'segments': segments,
                'language': info.language,
                'duration': info.duration,
                '_stats': {
                    'transcribe_time_s': round(transcribe_time, 2),
                    'realtime_factor': round(info.duration / transcribe_time, 2) if transcribe_time > 0 else 0,
                    'segment_count': len(segments)
                }
            }

            print(f"  ✓ {len(segments)} segments in {transcribe_time:.1f}s ({response['_stats']['realtime_factor']}x realtime)", file=sys.stderr)
            print(json.dumps(response, ensure_ascii=False), flush=True)

        except Exception as e:
            print(json.dumps({'error': str(e)}, ensure_ascii=False), flush=True)

    print("Whisper Worker exiting.", file=sys.stderr)

if __name__ == '__main__':
    main()
