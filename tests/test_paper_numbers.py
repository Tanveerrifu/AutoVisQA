"""Regression test: the archive in results/ must still reproduce the ICCIT 2026 paper's numbers.
Skipped automatically when the capture archive is not present."""
import os
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RESULTS = os.path.join(ROOT, "results")
ARCHIVE = os.path.join(RESULTS, "python-30-Aug-2026(12_38PM)", "summary.json")


@unittest.skipUnless(os.path.exists(ARCHIVE), "capture archive not present")
class PaperNumbersTest(unittest.TestCase):
    def run_script(self, name):
        out = subprocess.run([sys.executable, name], cwd=RESULTS, capture_output=True, text=True, timeout=600)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout

    def test_collision_rate(self):
        out = self.run_script("evidence_inventory.py")
        affected = sum(int(line.split("collision_affected_entries=")[1]) for line in out.splitlines()
                       if "collision_affected_entries=" in line)
        entries = sum(int(line.split("manifest_entries=")[1].split()[0]) for line in out.splitlines()
                      if "manifest_entries=" in line)
        self.assertEqual((affected, entries), (35, 260))

    @unittest.skipUnless(os.path.exists(os.path.join(RESULTS, "paper-iccit2026", "data", "static_pairs.csv")),
                         "paper data tables not present")
    def test_ipr_and_irr(self):
        out = self.run_script("evl_final_analysis.py")
        self.assertIn("TOTAL comparable pairs (base->final, 5 subjects): 81", out)
        self.assertIn("IPR = 11.1%", out)
        self.assertIn("Impossible records (strict, gated -- only among pairs that passed geometry/taint gates): 3 / 72", out)


if __name__ == "__main__":
    unittest.main()
