"""检查发布包内容和重复构建，不依赖开发机身份或真实账号数据。"""
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_script", ROOT / "scripts/package.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackageTests(unittest.TestCase):
    def test_exact_files_and_source_match(self):
        output = packaging.build()
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), {
                "extension/manifest.json", "extension/bridge.js", "extension/content.js",
                "extension/content.css", "README.md", "LICENSE", "PRIVACY.md", "docs/preview.svg",
            })
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (ROOT / name).read_bytes())
            manifest = json.loads(archive.read("extension/manifest.json"))
            self.assertEqual(manifest["version"], json.loads((ROOT / "package.json").read_text())["version"])

    def test_reproducible_and_checksum(self):
        output = packaging.build()
        first = output.read_bytes()
        packaging.build()
        self.assertEqual(first, output.read_bytes())
        expected = hashlib.sha256(first).hexdigest()
        self.assertEqual((output.parent / "SHA256SUMS.txt").read_text(), f"{expected}  {output.name}\n")


if __name__ == "__main__":
    unittest.main()
