import struct, os
src = os.path.dirname(os.path.abspath(__file__))
files = {'ic07': 'icon-128.png', 'ic08': 'icon-256.png', 'ic09': 'icon-512.png', 'ic10': 'icon-1024.png'}
body = b""
for typ, name in files.items():
    raw = open(os.path.join(src, name), "rb").read()
    body += typ.encode("ascii") + struct.pack(">I", len(raw) + 8) + raw
out = b"icns" + struct.pack(">I", 8 + len(body)) + body
open(os.path.join(src, "icon.icns"), "wb").write(out)
