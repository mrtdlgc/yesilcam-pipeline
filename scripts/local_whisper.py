#!/usr/bin/env python3
"""One-file diagnostic using exactly the resident worker's configuration."""
import argparse
import json
import os
import sys
from whisper_runtime import load_model, transcribe, resource_limits


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio_file', nargs='?')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--language', '-l', default='tr')
    parser.add_argument('--model', '-m', default=None)
    parser.add_argument('--device', choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type')
    parser.add_argument('--word-timestamps', action='store_true')
    parser.add_argument('--output', '-o')
    parser.add_argument('--prompt', '-p')
    args = parser.parse_args()
    if args.check:
        try:
            import faster_whisper
            print(json.dumps({'installed': True, 'version': faster_whisper.__version__, **resource_limits()}))
            return 0
        except ImportError:
            print(json.dumps({'installed': False}))
            return 1
    if not args.audio_file or not os.path.isfile(args.audio_file):
        parser.error('An existing audio_file is required')
    model, runtime = load_model(args.model, args.device, args.compute_type)
    result = transcribe(model, args.audio_file, args.language, args.prompt, args.word_timestamps)
    result['_runtime'] = runtime
    encoded = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as handle:
            handle.write(encoded)
    else:
        print(encoded)
    return 0


if __name__ == '__main__':
    sys.exit(main())
