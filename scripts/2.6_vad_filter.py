#!/usr/bin/env python3
"""Compatibility CLI for inspecting chunk speech; never discards uncertain speech."""
import argparse
import json
from pathlib import Path
from silero_runtime import load_model, profile_audio, save_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('chunks_json', nargs='?')
    parser.add_argument('--output')
    parser.add_argument('--threshold', type=float, default=0.5)
    parser.add_argument('--min-speech-ms', type=int, default=250)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        import torch
        import silero_vad
        print(json.dumps({'installed': True, 'torch_version': torch.__version__}))
        return
    if not args.chunks_json:
        parser.error('Provide chunks_json')
    data = json.loads(Path(args.chunks_json).read_text(encoding='utf-8'))
    chunks = data if isinstance(data, list) else data['chunks']
    model = load_model()
    kept = []
    for chunk in chunks:
        profile = profile_audio(chunk['file'], model)
        speech = sum(frame['prob'] >= args.threshold for frame in profile['profile']) * 0.032
        kept.append({**chunk, 'hasSpeech': speech * 1000 >= args.min_speech_ms,
                     'speechRatio': min(1, speech / profile['duration'])})
    result = {'kept': kept, 'discarded': [], 'stats': {'total_chunks': len(chunks), 'kept_count': len(kept)}}
    if args.output:
        save_json(args.output, result)
    else:
        print(json.dumps(result))


if __name__ == '__main__':
    main()
