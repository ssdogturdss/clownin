import socket
import struct
import sys
import threading

port, socket_path = int(sys.argv[1]), sys.argv[2]
broker = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
broker.connect(socket_path)
write_lock = threading.Lock()
streams = {}
OPEN, DATA, END = 1, 2, 3

def send(kind, stream_id, payload=b""):
    with write_lock:
        broker.sendall(struct.pack("!BII", kind, stream_id, len(payload)) + payload)

def forward(stream_id, source):
    try:
        while data := source.recv(65536):
            send(DATA, stream_id, data)
    finally:
        source.close()
        streams.pop(stream_id, None)
        send(END, stream_id)

while True:
    header = broker.recv(9)
    if not header:
        break
    while len(header) < 9:
        header += broker.recv(9 - len(header))
    kind, stream_id, length = struct.unpack("!BII", header)
    if length > 1024 * 1024:
        break
    payload = b""
    while len(payload) < length:
        payload += broker.recv(length - len(payload))
    if kind == OPEN:
        upstream = socket.create_connection(("127.0.0.1", port))
        streams[stream_id] = upstream
        threading.Thread(target=forward, args=(stream_id, upstream), daemon=True).start()
    elif kind == DATA and stream_id in streams:
        streams[stream_id].sendall(payload)
    elif kind == END and stream_id in streams:
        streams[stream_id].shutdown(socket.SHUT_WR)