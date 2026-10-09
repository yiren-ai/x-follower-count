"""按固定白名单生成可复现安装包，避免把开发机文件带入发布。"""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "extension/manifest.json", "extension/bridge.js", "extension/content.js",
    "extension/content.css", "README.md", "LICENSE", "PRIVACY.md", "docs/preview.svg",
]


def build():
    version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
    assert version == json.loads((ROOT / "package.json").read_text())["version"]
    output = ROOT / "dist" / f"x-follower-count-{version}.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"发布文件缺失或为符号链接：{name}")
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, source.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    (output.parent / "SHA256SUMS.txt").write_text(f"{digest}  {output.name}\n")
    print(f"{output.name}: {len(FILES)} 个文件，SHA-256 {digest}")
    return output


if __name__ == "__main__":
    build()
