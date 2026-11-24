"""Run with:  python -m unittest discover -s tests -v"""
import os
import pathlib
import sys
import tempfile
import threading
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from shonchoy import core  # noqa: E402


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="shonchoy-test-"))
        src = self.tmp / "src"
        (src / "sub").mkdir(parents=True)
        (src / "a.txt").write_text("hello shonchoy " * 500, encoding="utf-8")
        (src / "sub" / "b.bin").write_bytes(os.urandom(200_000))
        (src / "empty.txt").write_text("", encoding="utf-8")
        self.src = src

    def test_every_format_round_trips(self):
        for fmt, (_label, ext) in core.FORMATS.items():
            with self.subTest(fmt=fmt):
                out = self.tmp / f"out_{fmt.replace('.', '_')}{ext}"
                res = core.create_archive(out, [self.src], fmt, 6)
                self.assertTrue(out.exists())
                self.assertEqual(res["files"], 3)

                names = {e.name for e in core.list_archive(out)}
                self.assertIn("src/a.txt", names)
                self.assertIn("src/sub/b.bin", names)

                dest = self.tmp / f"x_{fmt.replace('.', '_')}"
                rep = core.extract_archive(out, dest)
                self.assertEqual(rep["errors"], [])
                self.assertEqual(rep["extracted"], 3)
                self.assertEqual((dest / "src" / "sub" / "b.bin").read_bytes(),
                                 (self.src / "sub" / "b.bin").read_bytes())

                check = core.test_archive(out)
                self.assertEqual(check["errors"], [])
                self.assertEqual(check["checked"], 3)

    def test_excludes_are_honoured(self):
        out = self.tmp / "ex.zip"
        core.create_archive(out, [self.src], "zip-deflate", 6, ["*.txt"])
        names = {e.name for e in core.list_archive(out)}
        self.assertNotIn("src/a.txt", names)
        self.assertIn("src/sub/b.bin", names)

    def test_zip_slip_is_blocked(self):
        evil = self.tmp / "evil.zip"
        with zipfile.ZipFile(evil, "w") as z:
            z.writestr("../escape.txt", "x")
            z.writestr("ok.txt", "y")
        dest = self.tmp / "safe"
        rep = core.extract_archive(evil, dest)
        self.assertIn("../escape.txt", rep["unsafe"])
        self.assertFalse((self.tmp / "escape.txt").exists())
        self.assertTrue((dest / "ok.txt").exists())

    def test_rename_and_skip_policies(self):
        out = self.tmp / "c.zip"
        core.create_archive(out, [self.src], "zip-store")
        dest = self.tmp / "d"
        core.extract_archive(out, dest)
        core.extract_archive(out, dest, overwrite="rename")
        self.assertTrue((dest / "src" / "a (2).txt").exists())
        rep = core.extract_archive(out, dest, overwrite="skip")
        self.assertEqual(rep["skipped"], 3)

    def test_selected_subset_extracts_only_that_folder(self):
        out = self.tmp / "sel.zip"
        core.create_archive(out, [self.src], "zip-deflate")
        dest = self.tmp / "only_sub"
        rep = core.extract_archive(out, dest, selected={"src/sub/"})
        self.assertEqual(rep["extracted"], 1)
        self.assertTrue((dest / "src" / "sub" / "b.bin").exists())
        self.assertFalse((dest / "src" / "a.txt").exists())

    def test_cancel_removes_partial_output(self):
        ev = threading.Event()
        ev.set()
        out = self.tmp / "n.zip"
        with self.assertRaises(core.Cancelled):
            core.create_archive(out, [self.src], "zip-deflate", 6, (), None, ev)
        self.assertFalse(out.exists())
        self.assertFalse((self.tmp / "n.zip.part").exists())

    def test_empty_selection_is_rejected(self):
        with self.assertRaises(ValueError):
            core.create_archive(self.tmp / "e.zip", [self.src], "zip-deflate", 6, ["*"])

    def test_corrupt_zip_is_reported_not_crashing(self):
        out = self.tmp / "good.zip"
        core.create_archive(out, [self.src], "zip-store")
        data = bytearray(out.read_bytes())
        # Flip bytes inside the stored payload of the first member.
        for i in range(200, 260):
            data[i] ^= 0xFF
        bad = self.tmp / "bad.zip"
        bad.write_bytes(bytes(data))
        res = core.test_archive(bad)
        self.assertTrue(res["errors"] or res["checked"] < 3)

    def test_name_helpers(self):
        self.assertEqual(core.safe_name("a/../b"), None)
        self.assertEqual(core.safe_name("/etc/passwd"), None)
        self.assertEqual(core.safe_name("C:\\x"), None)
        self.assertEqual(core.safe_name("./dir\\file.txt"), "dir/file.txt")
        self.assertEqual(core.strip_archive_ext("photos.tar.gz"), "photos")
        self.assertEqual(core.strip_archive_ext("notes.zip"), "notes")
        self.assertEqual(core.human_size(1536), "1.5 KB")


if __name__ == "__main__":
    unittest.main()
