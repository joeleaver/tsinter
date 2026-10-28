# Hostile TLS servers (the O2/O3 security review's hz kit): one listener
# per mode, each completing (or breaking) the handshake through
# ssl.SSLObject over the raw socket and then misbehaving — garbage or
# oversized records, a bad MAC, an alert after part of the body, a reset
# mid-body, duplicate ChangeCipherSpec, a truncated flight, ... — for the
# fetch rows of tests/harness/wasmnative-host-rows.test.ts, which hold the
# wasm-native lane's undici-shaped error mapping to Node's.
#
#   hostile.py MAXV CERT KEY      (MAXV 13 or 12: the highest TLS version)
#
# prints "<mode> <port>" per mode, then "ready"; serves until killed.
import socket, ssl, sys, threading, random, struct, time
MAXV=sys.argv[1]; CERT=sys.argv[2]; KEY=sys.argv[3]
MODES=['garbage','oversize','rst_mid','pre_garbage','pre_alert','frag','trunc_eof','cn_then_garbage','half_hs','empty_recs','bad_mac','ok','alert_after','hello_v2','huge_hdr','dup_ccs']
def ctx():
    c=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(CERT,KEY)
    if MAXV=='12': c.maximum_version=ssl.TLSVersion.TLSv1_2
    return c
def recv_some(s):
    try: return s.recv(65536)
    except Exception: return b''
def handshake(s, c):
    inc=ssl.MemoryBIO(); out=ssl.MemoryBIO(); o=c.wrap_bio(inc,out,server_side=True)
    while True:
        try: o.do_handshake(); break
        except ssl.SSLWantReadError:
            d=out.read()
            if d: s.sendall(d)
            d=recv_some(s)
            if not d: return None
            inc.write(d)
    d=out.read()
    if d: s.sendall(d)
    # read the request (if any) for a moment
    s.settimeout(0.5)
    try:
        d=s.recv(65536)
        if d: inc.write(d)
        try: o.read(65536)
        except Exception: pass
    except Exception: pass
    s.settimeout(None)
    return o,inc,out
def enc(o,out,data):
    o.write(data); return out.read()
RESP=b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"
def serve(i,mode,ls):
    while True:
        s,_=ls.accept()
        threading.Thread(target=one,args=(s,mode,i),daemon=True).start()
def one(s,mode,i):
    rnd=random.Random(1000+i)
    try:
        c=ctx()
        if mode=='pre_garbage':
            recv_some(s); s.sendall(bytes(rnd.getrandbits(8) for _ in range(3000))); time.sleep(0.5); s.close(); return
        if mode=='pre_alert':
            recv_some(s); s.sendall(b'\x15\x03\x03\x00\x02\x02\x28'); time.sleep(0.5); s.close(); return
        if mode=='hello_v2':
            recv_some(s); s.sendall(b'\x16\x03\x03\x00\x04\x02\x00\x00\x00'); time.sleep(0.5); s.close(); return
        if mode=='huge_hdr':
            recv_some(s); s.sendall(b'\x16\x03\x03\xff\xff'+bytes(1000)); time.sleep(0.5); s.close(); return
        if mode=='half_hs':
            inc=ssl.MemoryBIO(); out=ssl.MemoryBIO(); o=c.wrap_bio(inc,out,server_side=True)
            d=recv_some(s); inc.write(d)
            try: o.do_handshake()
            except ssl.SSLWantReadError: pass
            fl=out.read(); s.sendall(fl[:60]); time.sleep(0.3); s.close(); return
        r=handshake(s,c)
        if r is None: s.close(); return
        o,inc,out=r
        if mode=='garbage':
            s.sendall(bytes(rnd.getrandbits(8) for _ in range(4096)))
        elif mode=='oversize':
            n=16384+2048+1; s.sendall(b'\x17\x03\x03'+struct.pack('>H',n)+bytes(rnd.getrandbits(8) for _ in range(n)))
        elif mode=='bad_mac':
            rec=bytearray(enc(o,out,RESP)); rec[-1]^=1; s.sendall(bytes(rec))
        elif mode=='rst_mid':
            s.sendall(enc(o,out,b"HTTP/1.1 200 OK\r\ncontent-length: 100000\r\n\r\n"+b"x"*5000)); time.sleep(0.2)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii',1,0)); s.close(); return
        elif mode=='frag':
            body=bytes((rnd.getrandbits(7)+32) for _ in range(300000))
            data=enc(o,out,b"HTTP/1.1 200 OK\r\ncontent-length: 300000\r\n\r\n"+body)
            p=0
            while p<len(data):
                k=1 if p<3000 else rnd.randint(1,40000); s.sendall(data[p:p+k]); p+=k
                if p<3000: time.sleep(0.0005)
        elif mode=='trunc_eof':
            s.sendall(enc(o,out,b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n"+b"y"*1000000)); time.sleep(0.2); s.close(); return
        elif mode=='cn_then_garbage':
            s.sendall(enc(o,out,RESP.replace(b'content-length: 5',b'connection: close'))); 
            try: o.unwrap()
            except Exception: pass
            s.sendall(out.read()+bytes(rnd.getrandbits(8) for _ in range(500))); time.sleep(0.2); s.close(); return
        elif mode=='empty_recs':
            for _ in range(64): s.sendall(enc(o,out,b''))
            # python won't make empty records: craft by sending RESP in 1-byte records instead
            for b in RESP[:-1]: s.sendall(enc(o,out,bytes([b])))
        elif mode=='alert_after':
            s.sendall(enc(o,out,b"HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\nabc")); time.sleep(0.1)
            s.sendall(b'\x15\x03\x03\x00\x02\x02\x50')
        elif mode=='dup_ccs':
            s.sendall(b'\x14\x03\x03\x00\x01\x01'*3)
        elif mode=='ok':
            s.sendall(enc(o,out,RESP))
        time.sleep(1.0); s.close()
    except Exception as e:
        try: s.close()
        except Exception: pass
for i,m in enumerate(MODES):
    ls=socket.socket(); ls.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); ls.bind(('127.0.0.1',0)); ls.listen(16)
    print(m, ls.getsockname()[1], flush=True)
    threading.Thread(target=serve,args=(i,m,ls),daemon=True).start()
print('ready',flush=True)
while True: time.sleep(3600)
