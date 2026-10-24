#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys
from silero_runtime import load_model, profile_audio, save_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('audio_file', nargs='?')
    parser.add_argument('--batch')
    parser.add_argument('--output', '-o')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        import torch
        import silero_vad
        print(json.dumps({'installed': True, 'torch_version': torch.__version__}))
        return
    model = load_model()
    if args.batch:
        data = json.loads(Path(args.batch).read_text(encoding='utf-8'))
        chunks = data if isinstance(data, list) else data['chunks']
        for i, chunk in enumerate(chunks):
            print(f'Silero profile {i + 1}/{len(chunks)}', file=sys.stderr, flush=True)
            save_json(Path(args.output) / f'profile_{chunk["id"]}.json', profile_audio(chunk['file'], model))
            print('YESILCAM_PROGRESS ' + json.dumps({'completed': i + 1, 'total': len(chunks), 'detail': f'Speech profile {i + 1}/{len(chunks)} saved'}), file=sys.stderr, flush=True)
    elif args.audio_file:
        result = profile_audio(args.audio_file, model)
        if args.output:
            save_json(args.output, result)
        else:
            print(json.dumps(result))
    else:
        parser.error('Provide audio_file or --batch')


if __name__ == '__main__':
    main()
