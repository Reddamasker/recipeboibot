#!/usr/bin/python3 -I
"""Server entry point for the restricted recipe-deploy SSH key."""

import fcntl
import gzip
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


TOOLS = Path("/usr/local/libexec/recipeboibot-release-tools")
BASE = Path("/opt")
PRODUCTION = BASE / "recipeboibot"
TEST = BASE / "recipeboibot-test"
MAX = BASE / "recipeboibot-max"
CONTOURS = {"production": PRODUCTION, "test": TEST, "max": MAX}
MAX_UPLOAD = 128 * 1024**2
MAX_EXPANDED = 512 * 1024**2
APP_DIRECTORIES = {"src", "public", "test"}
PRODUCTION_TOOLS = (
    "enable-persistent-logs.py", "ops-monitor.sh", "enable-monitor.sh", "storage.py",
    "apply-storage.sh", "retention.sh", "backup.sh", "recipeboibot-retention.service",
    "recipeboibot-retention.timer", "recipeboibot-monitor.service", "recipeboibot-monitor.timer",
)


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True, stdin=subprocess.DEVNULL)


def check(contour):
    root = CONTOURS[contour]
    if not (root / ".env.local").is_file():
        raise ValueError("Missing server-side configuration")
    if contour == "max":
        run("/bin/bash", TOOLS / "deploy/apply-max-release.sh", "--check")
    else:
        compose = "compose.yaml" if contour == "production" else "compose.test.yaml"
        port = 3087 if contour == "production" else 3088
        run("docker", "compose", "-f", compose, "ps", cwd=root)
        run("curl", "-fsS", "--max-time", "20", f"http://127.0.0.1:{port}/healthz")
    run("/usr/bin/python3", root / "deploy/storage.py", "preflight", contour)


def copy_limited(source, destination, limit, error):
    while chunk := source.read(1024**2):
        limit -= len(chunk)
        if limit < 0:
            raise ValueError(error)
        destination.write(chunk)


def receive_source(stage):
    upload = stage / "received.tgz"
    with upload.open("wb") as output:
        copy_limited(sys.stdin.buffer, output, MAX_UPLOAD, "Release archive exceeds the upload limit")
    expanded = stage / "received.tar"
    with gzip.open(upload, "rb") as compressed, expanded.open("wb") as output:
        copy_limited(compressed, output, MAX_EXPANDED, "Release archive exceeds the expanded size limit")

    source = stage / "source"
    source.mkdir()
    seen = set()
    with tarfile.open(expanded, "r:") as archive:
        for entry in archive:
            parts = entry.name.split("/")
            if (
                len(seen) >= 20000 or entry.name in seen
                or any(part in {"", ".", ".."} for part in parts)
                or not (parts[0] in APP_DIRECTORIES or parts == ["package.json"])
                or (len(parts) == 1 and entry.isdir() != (parts[0] in APP_DIRECTORIES))
                or not (entry.isdir() or entry.isreg())
            ):
                raise ValueError("Unexpected release archive entry")
            seen.add(entry.name)
            destination = source.joinpath(*parts)
            if entry.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(entry) as contents, destination.open("xb") as output:
                shutil.copyfileobj(contents, output)

    for name in ("src/index.js", "public/index.html", "package.json"):
        if not (source / name).is_file():
            raise ValueError(f"Missing application file {name}")
    if not any((source / "test").glob("*.test.js")):
        raise ValueError("Missing application tests")
    return source


def source_hash(root):
    digest = hashlib.sha256()

    def append_tree(directory):
        for entry in sorted(directory.iterdir(), key=lambda path: os.fsencode(path.name)):
            if entry.is_dir():
                append_tree(entry)
            else:
                digest.update(os.fsencode(entry.relative_to(root).as_posix()) + b"\0")
                with entry.open("rb") as data:
                    while chunk := data.read(1024**2):
                        digest.update(chunk)

    for directory in ("src", "public"):
        append_tree(root / directory)
    return digest.hexdigest()


def package_release(source, contour, archive):
    installed = CONTOURS[contour]
    with tarfile.open(archive, "w:gz") as output:
        for name in ("src", "public", "package.json"):
            output.add(source / name, name)
        output.add(installed / "Dockerfile", "Dockerfile")
        if contour == "production":
            for name in PRODUCTION_TOOLS:
                output.add(installed / "deploy" / name, f"deploy/{name}")
        else:
            output.add(source / "test", "test")
            output.add(installed / "scripts", "scripts")
            output.add(installed / "deploy", "deploy")


def apply(contour, revision, archive, expected):
    with archive.open("rb") as data:
        checksum = hashlib.file_digest(data, "sha256").hexdigest()
    if contour == "production":
        remote = Path(f"/root/recipeboibot-release-{revision}.tgz")
        command = (
            "/bin/sh", TOOLS / "deploy/apply-release.sh", revision, remote,
            "https://dishfinder.ru", expected,
        )
    elif contour == "test":
        remote = Path(f"/root/recipeboibot-test-release-{checksum}.tgz")
        command = ("/bin/bash", TOOLS / "deploy/apply-test-release.sh", checksum, expected)
    else:
        remote = Path(f"/root/recipeboibot-max-release-{checksum}.tgz")
        command = (
            "/bin/bash", TOOLS / "deploy/apply-max-release.sh", "--apply",
            revision, checksum, expected,
        )
    uploaded = remote.open("xb")
    try:
        with uploaded, archive.open("rb") as data:
            shutil.copyfileobj(data, uploaded)
        run(*command)
    finally:
        remote.unlink()


def main():
    if len(sys.argv) != 2:
        raise ValueError("Expected one release command")
    command = re.fullmatch(r"(check|validate|apply) (test|production|max)(?: ([0-9a-f]{40}))?", sys.argv[1])
    if not command:
        raise ValueError("This SSH key only accepts recipebot release commands")
    action, contour, revision = command.groups()
    if action == "check" and revision is None:
        check(contour)
        return
    if action not in {"apply", "validate"} or revision is None:
        raise ValueError("This release command requires a Git revision")

    os.umask(0o022)
    with tempfile.TemporaryDirectory(prefix="recipeboibot-cloud-", dir="/root") as stage:
        archive = Path(stage) / "release.tgz"
        source = receive_source(Path(stage))
        expected = source_hash(source)
        package_release(source, contour, archive)
        if action == "validate":
            print(f"Release package verified for {contour}: {revision} {expected}")
            return
        with (TOOLS / "release.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            check(contour)
            apply(contour, revision, archive, expected)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, EOFError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print(f"Recipebot release failed: {error}", file=sys.stderr)
        sys.exit(1)
