import sys
from rembg import remove, new_session
session = new_session("silueta")
with open(sys.argv[1], 'rb') as i:
    data = i.read()
with open(sys.argv[2], 'wb') as o:
    o.write(remove(data, session=session))
