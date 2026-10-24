#!/usr/bin/env python3
"""Manual comparison on retained vocals. --list does not import inference libraries."""
import argparse
import json
import os
from pathlib import Path
import re
from whisper_runtime import load_model, transcribe


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--temp-dir', default=str(Path(os.environ.get('DATA_DIR', Path(__file__).resolve().parent.parent)) / 'temp'))
    parser.add_argument('--job', help='Job ID; required for transcription if multiple jobs exist')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--limit', type=int, default=3)
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--chunk', type=int)
    parser.add_argument('--model')
    parser.add_argument('--device', choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type')
    parser.add_argument('--language', default='tr')
    parser.add_argument('--word-timestamps', action='store_true')
    parser.add_argument('--output', '-o')
    parser.add_argument('--quiet', '-q', action='store_true')
    args = parser.parse_args()
    if args.job and not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', args.job):
        parser.error('Invalid job ID')
    root = Path(args.temp_dir)
    files = sorted(root.glob(f'{args.job or "*"}/vocals/chunk_*_vocals.wav'))
    if args.list:
        for file in files:
            print(file)
        return
    if not files:
        parser.error('No retained vocal chunks were found')
    if len({file.parent.parent for file in files}) > 1:
        parser.error('Choose --job to avoid mixing separate films')
    if args.limit < 1:
        parser.error('--limit must be positive')
    if args.chunk is not None:
        files = [file for file in files if int(re.search(r'chunk_(\d+)_', file.name)[1]) == args.chunk]
    elif not args.all:
        files = files[:args.limit]
    if not files:
        parser.error('Requested chunk was not found')
    model, runtime = load_model(args.model, args.device, args.compute_type)
    results = []
    for file in files:
        result = transcribe(model, str(file), args.language, word_timestamps=args.word_timestamps)
        results.append({'file': str(file), **result})
        if not args.quiet:
            print(f'{file.name}: {result["text"]}')
    data = {'runtime': runtime, 'results': results}
    if args.output:
        Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
