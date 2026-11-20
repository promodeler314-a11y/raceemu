"""RefDumpTest の system-out を umasim-reference.json の形にする。

使い方: python3 -I parse_refdump.py <TEST-*.xml> <出力 json>
SKILLIDS は既存の JSON と同じく「skill」キー 1 つに畳む（同じキーの行は後勝ち）。
"""
import json
import sys
import xml.etree.ElementTree as ET

xml_path, out_path = sys.argv[1], sys.argv[2]
root = ET.parse(xml_path).getroot()
text = "".join(e.text or "" for e in root.iter("system-out"))

out = {}
section = None
label = None
for line in text.splitlines():
    if line.startswith("=== "):
        parts = line.split(" ", 2)
        if parts[1] == "END":
            section = None
            continue
        section, label = parts[1].lower(), parts[2]
        out.setdefault(label, {})[section] = {}
        continue
    if section is None or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if section == "skillids":
        out[label][section][key] = value
    elif key == "wisdomSkillBuff":
        out[label][section][key] = [float(v) for v in value.split(",")]
    else:
        out[label][section][key] = float(value)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
