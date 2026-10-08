"""The disabled CLI must fail before reading inputs or creating outputs."""

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class DisabledCliTests(unittest.TestCase):
    def test_all_invocations_fail_without_touching_files(self):
        script = Path(__file__).resolve().parents[1] / "src" / "dicom_anonymizer.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "input"
            source.mkdir()
            original = source / "1.2.826.0.1"
            original.write_bytes(b"synthetic identifier - must remain unchanged")
            output = root / "output"
            for args in ([], ["--help"], ["-i", str(source), "-o", str(output), "-p", "ANON_001"]):
                with self.subTest(args=args):
                    result = subprocess.run(
                        [sys.executable, "-S", str(script), *args],
                        cwd=root, capture_output=True, text=True, timeout=10,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("DICOM anonymization is disabled", result.stderr)
                    self.assertIn("No files were read or written", result.stderr)
                    self.assertFalse(output.exists())
                    self.assertEqual(original.read_bytes(), b"synthetic identifier - must remain unchanged")
                    self.assertEqual(list(root.iterdir()), [source])


if __name__ == "__main__":
    unittest.main()
