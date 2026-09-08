import io, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
py = json.load(io.open(os.path.join(HERE, 'py.json'), encoding='utf-8'))
js = json.load(io.open(os.path.join(HERE, 'js.json'), encoding='utf-8'))

def norm(v):
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, tuple):
        return list(v)
    return v


def project(want, got):
    """
    Drop fields the JS side has and the Python side does not, at any depth.

    Two legitimate sources of extras: the JS Show carries camelCase getters that
    the Python dataclass has no equivalent for, and the web version tracks
    number_absolute on episodes to support absolute numbering, which the desktop
    tool has no concept of. Everything Python *does* publish must still match
    exactly — this only ignores additions, never differences.
    """
    if isinstance(want, dict) and isinstance(got, dict):
        return {k: project(want[k], got[k]) for k in got if k in want}
    if isinstance(want, list) and isinstance(got, list):
        return [project(want[i], g) if i < len(want) else g for i, g in enumerate(got)]
    return got


fails = []
for key in sorted(set(py) | set(js)):
    a, b = norm(py.get(key)), norm(js.get(key))
    b = project(a, b)
    if a != b:
        fails.append(key)
        print('=== MISMATCH:', key)
        if isinstance(a, dict):
            for k in sorted(set(a) | set(b)):
                if a.get(k) != b.get(k):
                    print('   ', k, '\n      py:', repr(a.get(k))[:300], '\n      js:', repr(b.get(k))[:300])
        elif isinstance(a, list) and isinstance(b, list):
            for i in range(max(len(a), len(b))):
                x = a[i] if i < len(a) else '<missing>'
                y = b[i] if i < len(b) else '<missing>'
                if x != y:
                    if isinstance(x, dict) and isinstance(y, dict):
                        for k in sorted(set(x) | set(y)):
                            if x.get(k) != y.get(k):
                                print(f'    [{i}].{k}\n      py: {x.get(k)!r}\n      js: {y.get(k)!r}')
                    else:
                        print(f'    [{i}]\n      py: {x!r}\n      js: {y!r}')
        else:
            pa, pb = str(a).split('\n'), str(b).split('\n')
            for i in range(max(len(pa), len(pb))):
                x = pa[i] if i < len(pa) else '<missing>'
                y = pb[i] if i < len(pb) else '<missing>'
                if x != y:
                    print(f'    line {i}\n      py: {x!r}\n      js: {y!r}')
    else:
        print('ok  ', key)
print()
print('FAILED' if fails else 'ALL MATCH', fails)
sys.exit(1 if fails else 0)
