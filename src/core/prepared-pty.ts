// Python's standard-library PTY avoids installing native Node modules on HPC hosts.
export const PREPARED_PTY_SOURCE = String.raw`
import os, sys, pty, json, base64, select, signal, fcntl, termios, struct, errno
c = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(c['cwd'])
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.execvpe(c['command'], [c['command']] + c['args'], os.environ)
def send(v):
    sys.stdout.write(json.dumps(v) + '\n')
    sys.stdout.flush()
def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
def kill_child(sig):
    groups = {pid}
    try: groups.add(os.tcgetpgrp(fd))
    except OSError: pass
    for group in groups:
        if group > 0:
            try: os.killpg(group, sig)
            except ProcessLookupError: pass
resize(c.get('cols',100), c.get('rows',30))
buffer = b''
code = None
try:
    while code is None:
        ready, _, _ = select.select([fd, sys.stdin.buffer], [], [], 0.1)
        if fd in ready:
            try: data = os.read(fd, 32768)
            except OSError as e:
                if e.errno != errno.EIO: raise
                data = b''
            if data: send({'data':base64.b64encode(data).decode('ascii')})
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            buffer += data
            if len(buffer) > 200000: raise ValueError('PTY input frame too large')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n',1)
                req = json.loads(line)
                if req['op'] == 'input':
                    payload = base64.b64decode(req['data'])
                    while payload:
                        n = os.write(fd,payload)
                        payload = payload[n:]
                elif req['op'] == 'resize': resize(req['cols'],req['rows'])
                elif req['op'] == 'kill': kill_child(getattr(signal,req['signal']))
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            code = os.waitstatus_to_exitcode(status) if hasattr(os,'waitstatus_to_exitcode') else (os.WEXITSTATUS(status) if os.WIFEXITED(status) else -os.WTERMSIG(status))
    if code is not None:
        while select.select([fd],[],[],0)[0]:
            try: data = os.read(fd,32768)
            except OSError: break
            if not data: break
            send({'data':base64.b64encode(data).decode('ascii')})
        send({'exitCode':code if code >= 0 else 128-code})
finally:
    if code is None: kill_child(signal.SIGHUP)
    os.close(fd)
`;
