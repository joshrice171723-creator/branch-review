"""Install the Apex release shipped with Branch Review into the selected project."""
import hashlib
import json
from pathlib import Path
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
        root = Path(directory)
        with ZipFile(archive) as source:
            for name in source.namelist():
                target = (root / name).resolve()
                if not target.is_relative_to(root) or "\\" in name:
                    raise ValueError("The bundled archive contains an invalid path.")
            source.extractall(root)
        subprocess.run(["ruby", str(root / "bin/harness"), "setup", "install", "--project", str(project)], check=True)


if __name__ == "__main__":
    install(Path(sys.argv[1]).resolve(strict=True))
