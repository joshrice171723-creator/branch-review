"""Install the Apex release shipped with Branch Review into the selected project."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
from zipfile import ZipFile


def install(project):
    package = Path(__file__).resolve().parent / "workbench-release"
    archive = package / "apex.zip"
    release = json.loads((package / "release.json").read_text(encoding="utf8"))
    if hashlib.sha256(archive.read_bytes()).hexdigest() != release["sha256"]:
        raise ValueError("The bundled Workbench archive failed verification.")
    with tempfile.TemporaryDirectory(prefix="branch-review-apex-") as directory:
        scratch = Path(directory).resolve()
        root = scratch / "bundle"
        root.mkdir()
        with ZipFile(archive) as source:
            if len(source.namelist()) != len(set(source.namelist())):
                raise ValueError("The bundled archive contains duplicate paths.")
            for name in source.namelist():
                target = (root / name).resolve()
                if not target.is_relative_to(root) or "\\" in name:
                    raise ValueError("The bundled archive contains an invalid path.")
            source.extractall(root)
        manifest = (root / "MANIFEST.sha256").read_bytes()
        manifest_hash = hashlib.sha256(manifest).hexdigest()
        if release.get("manifestSha256", manifest_hash) != manifest_hash:
            raise ValueError("The bundled Workbench manifest failed verification.")
        home = project / ".harness"
        if home.resolve() != home:
            raise ValueError("The installed runtime must belong to this checkout.")
        progress = root / "design_progress.py"
        loops = home / "loops"
        if progress.is_file() and loops.is_dir():
            running = runpy.run_path(str(progress))["running"]
            if any(running(folder) for folder in loops.iterdir() if folder.is_dir()):
                raise ValueError("Finish or pause the running coordinator before updating Workbench.")
        existing = (home / "project.json").is_file()
        backup = scratch / "previous"
        paths = [row.split("  ", 1)[1] for row in manifest.decode("utf-8").splitlines()]
        paths += ["MANIFEST.sha256", "workbench-runtime.json"]
        if existing:
            for name in paths:
                target = checked_target(home, name)
                if target.is_file():
                    (backup / name).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(target, backup / name)
        try:
            subprocess.run(["ruby", str(root / "bin/harness"), "setup", "install", "--project", str(project)], check=True)
            if (home / "MANIFEST.sha256").read_bytes() != manifest:
                raise ValueError("The installed Workbench manifest differs from the bundle.")
            replace_file(home / "workbench-runtime.json", json.dumps({
                "revision": release["revision"], "manifestSha256": manifest_hash
            }).encode("utf-8"))
        except (OSError, ValueError, subprocess.SubprocessError):
            if existing:
                for name in paths:
                    target = checked_target(home, name)
                    previous = backup / name
                    if previous.is_file():
                        if not target.is_file() or target.read_bytes() != previous.read_bytes():
                            replace_file(target, previous.read_bytes())
                    elif target.is_file():
                        target.unlink()
            raise


def checked_target(home, name):
    target = home / name
    if target.resolve() != target or not target.is_relative_to(home):
        raise ValueError("Invalid installed Workbench path.")
    return target


def replace_file(target, content):
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".workbench-update-", delete=False) as stream:
        draft = Path(stream.name)
        stream.write(content)
    try:
        os.replace(draft, target)
    finally:
        draft.unlink(missing_ok=True)


if __name__ == "__main__":
    install(Path(sys.argv[1]).resolve(strict=True))
