import json, os, collections

subjects = {
    'nodejs': ['nodejs-30-Aug-2026(12_40PM)', 'nodejs-final-30-Aug-2026(12_51PM)'],
    'mdn': ['mdn-30-Aug-2026(12_42PM)', 'mdn-final-30-Aug-2026(12_54PM)'],
    'github-docs': ['github-docs-30-Aug-2026(12_47PM)', 'github-docs-final-30-Aug-2026(12_58PM)', 'github-docs-full-30-Aug-2026(1_05PM)'],
    'wikipedia': ['wikipedia-30-Aug-2026(12_44PM)', 'wikipedia-final-30-Aug-2026(12_56PM)', 'wikipedia-full-30-Aug-2026(1_03PM)'],
    'python': ['python-30-Aug-2026(12_38PM)', 'python-final-30-Aug-2026(12_49PM)', 'python-full-30-Aug-2026(1_01PM)'],
}

for subj, sessions in subjects.items():
    print(f"=== {subj} ===")
    for s in sessions:
        mpath = f"{s}/summary.json"
        if not os.path.exists(mpath):
            print(f"  {s}: NO MANIFEST")
            continue
        data = json.load(open(mpath))
        manifest_basenames = collections.Counter()
        for e in data:
            fn = os.path.basename(e['screenshotPath'].replace('\\', '/'))
            manifest_basenames[fn] += 1
        disk_files = set(os.listdir(f"{s}/screenshots")) if os.path.isdir(f"{s}/screenshots") else set()
        manifest_set = set(manifest_basenames.keys())
        missing_on_disk = manifest_set - disk_files
        orphans_on_disk = disk_files - manifest_set
        collisions = {k: v for k, v in manifest_basenames.items() if v > 1}
        n_collision_affected_entries = sum(v for v in collisions.values())
        print(f"  {s}: manifest_entries={len(data)} unique_names_in_manifest={len(manifest_set)} "
              f"disk_files={len(disk_files)} missing_on_disk={len(missing_on_disk)} orphans_on_disk={len(orphans_on_disk)} "
              f"collision_groups={len(collisions)} collision_affected_entries={n_collision_affected_entries}")
        if missing_on_disk:
            print(f"    MISSING ON DISK: {missing_on_disk}")
        if collisions:
            print(f"    COLLISIONS: {collisions}")
