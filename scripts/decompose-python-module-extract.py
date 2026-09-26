#!/usr/bin/env python3
"""Deterministic plain-module extraction for one file-decompose move (`python-module-extract`).

The Python sibling of decompose-node-module.js's CommonJS module-extract and this repo's
own decompose-blueprint-extract.py -- but for symbols with NO `@app.route` to anchor a
Flask Blueprint on (a Blueprint needs a URL to register; a bag of helper functions has
none). Reuses the same AST machinery as decompose-blueprint-extract.py, minus every
blueprint-specific step: no decorator rewriting, no Blueprint object, no
register_blueprint wiring. It also REJECTS any symbol that IS an @app.route view -- that
symbol belongs in a flask-blueprint move, not this one; the two kinds are mutually
exclusive by construction (see file-decompose-plan-pass.js's planFromNamePatterns, which
only ever offers this script symbols already excluded as routeless).

  decompose-python-module-extract.py <source.py> <sym1> [<sym2> ...]

Output: one JSON object on stdout.
  { "ok": true, "newFileContent": "...", "reducedSource": "...", "sharedDeps": {...} }
  { "ok": false, "problems": ["..."] }
Exit 0 whenever the file parsed; exit 2 only if it could not be read/parsed.
"""

import ast
import builtins
import json
import sys

BUILTIN_NAMES = set(dir(builtins))
ROUTE_DECORATOR_PREFIXES = ("@app.route", "@app.get", "@app.post", "@app.put",
                            "@app.delete", "@app.patch")


def decorator_is_app_route(dec):
    target = dec.func if isinstance(dec, ast.Call) else dec
    return (isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id == "app"
            and target.attr in ("route", "get", "post", "put", "delete", "patch"))


def span(node):
    lo = node.decorator_list[0].lineno if node.decorator_list else node.lineno
    return lo, node.end_lineno


def fail(problems):
    print(json.dumps({"ok": False, "problems": problems}))


def main(argv):
    if len(argv) < 3:
        fail(["usage: decompose-python-module-extract.py <source.py> <sym>..."])
        return 2
    path, symbols = argv[1], argv[2:]
    try:
        src = open(path, "r", encoding="utf-8").read()
        tree = ast.parse(src, filename=path)
    except (OSError, SyntaxError, ValueError) as exc:
        fail([f"{type(exc).__name__}: {exc}"])
        return 2
    lines = src.split("\n")

    module_funcs, module_names = {}, set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            module_funcs.setdefault(node.name, node)
            module_names.add(node.name)
        elif isinstance(node, ast.ClassDef):
            module_names.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    module_names.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            module_names.add(node.target.id)

    problems, moved = [], []
    for s in symbols:
        n = module_funcs.get(s)
        if n is None:
            problems.append(f"{s}: not a module-level function")
        else:
            moved.append(n)
    if problems:
        fail(problems)
        return 0
    # Mutual exclusivity with flask-blueprint moves: a route view has a real URL and
    # belongs in a Blueprint, not a plain helper module.
    routed = [n.name for n in moved if any(decorator_is_app_route(d) for d in n.decorator_list)]
    if routed:
        fail([f"{', '.join(routed)}: @app.route view(s) belong in a flask-blueprint move, not python-module-extract"])
        return 0

    moved_names = {n.name for n in moved}
    moved_lines = set()
    for n in moved:
        lo, hi = span(n)
        moved_lines.update(range(lo, hi + 1))

    strays = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in moved_names and node.lineno not in moved_lines:
            strays.setdefault(node.id, []).append(node.lineno)
    if strays:
        fail([f"{s} is still referenced at line(s) {sorted(set(v))} outside the moved symbols"
              for s, v in strays.items()])
        return 0

    import_line_for = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            line = "\n".join(lines[node.lineno - 1:node.end_lineno])
            for a in node.names:
                bound = a.asname or a.name
                if isinstance(node, ast.Import):
                    bound = bound.split(".")[0]
                import_line_for[bound] = line

    shared_deps = {}
    needed_import_lines, seen = [], set()
    for n in moved:
        local_bound, read = set(), set()
        for stmt in n.body:
            for sub in ast.walk(stmt):
                if isinstance(sub, ast.Name):
                    (local_bound if isinstance(sub.ctx, ast.Store) else read).add(sub.id)
                elif isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    local_bound.add(sub.name)
                elif isinstance(sub, ast.arg):
                    local_bound.add(sub.arg)
        # Same annotation gap decompose-blueprint-extract.py hardened for (2026-09-13): a
        # type annotation lives on n.returns / arg.annotation, not n.body -- a name used
        # only there was invisible here and crashed at def-time with a NameError.
        annotation_nodes = [n.returns] if n.returns else []
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs + ([n.args.vararg] if n.args.vararg else []) + ([n.args.kwarg] if n.args.kwarg else []):
            if a.annotation:
                annotation_nodes.append(a.annotation)
        for ann in annotation_nodes:
            for sub in ast.walk(ann):
                if isinstance(sub, ast.Name):
                    read.add(sub.id)
        for a in n.args.args + n.args.posonlyargs + n.args.kwonlyargs:
            local_bound.add(a.arg)
        if n.args.vararg:
            local_bound.add(n.args.vararg.arg)
        if n.args.kwarg:
            local_bound.add(n.args.kwarg.arg)
        shared_deps[n.name] = sorted(
            x for x in read
            if x in module_names and x not in moved_names
            and x not in local_bound and x not in BUILTIN_NAMES and x != "app")
        for x in sorted(read):
            if x in import_line_for and x not in local_bound and x not in BUILTIN_NAMES:
                il = import_line_for[x]
                if il not in seen:
                    seen.add(il)
                    needed_import_lines.append(il)

    all_deps = sorted({d for ds in shared_deps.values() for d in ds})

    header = []
    if needed_import_lines:
        header.extend(needed_import_lines)
        header.append("")
    if all_deps:
        header += [
            f"# The module-level names these functions read ({', '.join(all_deps)}) are",
            "# imported lazily inside each function: the source module imports THIS module,",
            "# so a top-level back-import would be circular. By call time the source module",
            "# is fully initialised and the import is just a dict lookup.",
            "",
        ]
    header.append("")

    fn_texts = []
    for n in moved:
        lo, hi = span(n)
        body = lines[lo - 1:hi]
        def_idx = next(i for i, x in enumerate(body)
                       if x.lstrip().startswith(("def ", "async def ")))
        insert_at = def_idx + 1
        fb = n.body[0] if n.body else None
        if (isinstance(fb, ast.Expr) and isinstance(getattr(fb, "value", None), ast.Constant)
                and isinstance(fb.value.value, str)):
            insert_at = (fb.end_lineno - lo) + 1
        deps = shared_deps[n.name]
        out = body
        if deps:
            module_name = path.rsplit("/", 1)[-1][:-3] if path.endswith(".py") else path
            out = body[:insert_at] + [f"    from {module_name} import {', '.join(deps)}"] + body[insert_at:]
        fn_texts.append("\n".join(out))

    new_content = "\n".join(header) + "\n\n\n".join(fn_texts) + "\n"

    spans = sorted((span(n) for n in moved), reverse=True)
    red = lines[:]
    for lo, hi in spans:
        end = hi
        while end < len(red) and red[end].strip() == "":
            end += 1
        del red[lo - 1:end]
    reduced = "\n".join(red)
    while "\n\n\n\n" in reduced:
        reduced = reduced.replace("\n\n\n\n", "\n\n\n")

    print(json.dumps({
        "ok": True,
        "newFileContent": new_content,
        "reducedSource": reduced,
        "sharedDeps": shared_deps,
        "movedCount": len(moved),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
