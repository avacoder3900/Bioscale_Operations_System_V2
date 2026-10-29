"""Every protocol's run-time parameters stay inside the Opentrons limits.

The robot's analysis rejects a protocol whose RTP metadata is too long — e.g.
`ParameterNameError: Description "..." greater than 100 characters` — and the
analysis then "completes with errors", which the run-start freshness gate
refuses. Caught on 2026-10-29 on the arm's rehearsal (and the production stage
.py had the same three descriptions).

    python -I protocols/tests/test_rtp_limits.py
"""
import ast
import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIMITS = {'variable_name': 40, 'display_name': 30, 'description': 100}


def literal_kwargs(call):
    """(kwarg, value) for the string-literal kwargs of an add_* call."""
    for kw in call.keywords:
        if kw.arg in LIMITS and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
            yield kw.arg, kw.value.value


def main():
    problems = []
    for path in sorted(glob.glob(os.path.join(ROOT, '*.py'))):
        with open(path, encoding='utf-8') as f:
            tree = ast.parse(f.read(), filename=path)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
                continue
            if not node.func.attr.startswith('add_'):
                continue
            for arg, value in literal_kwargs(node):
                if len(value) > LIMITS[arg]:
                    problems.append(f'{os.path.basename(path)}:{node.lineno} {arg} is {len(value)} chars (limit {LIMITS[arg]})')
    if problems:
        print('\n'.join(problems))
        sys.exit(1)
    print('ok: every RTP variable_name / display_name / description is inside the Opentrons limits')


if __name__ == '__main__':
    main()
