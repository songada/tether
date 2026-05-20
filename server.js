const FtpSrv = require('ftp-srv');
const bunyan = require('bunyan');
const path = require('path');
const fs = require('fs');
const os = require('os');

function detectLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const PORT = process.env.FTP_PORT ? Number(process.env.FTP_PORT) : 2121;
const HOST = process.env.FTP_HOST || '0.0.0.0';
const PASV_URL = process.env.FTP_PASV_URL || detectLanIp();
const PASV_MIN = process.env.FTP_PASV_MIN ? Number(process.env.FTP_PASV_MIN) : 50000;
const PASV_MAX = process.env.FTP_PASV_MAX ? Number(process.env.FTP_PASV_MAX) : 50100;
const ROOT = path.resolve(process.env.FTP_ROOT || './ftp-root');

fs.mkdirSync(ROOT, { recursive: true });

const ftpServer = new FtpSrv({
  url: `ftp://${HOST}:${PORT}`,
  pasv_url: PASV_URL,
  pasv_min: PASV_MIN,
  pasv_max: PASV_MAX,
  anonymous: true,
  greeting: ['Welcome to the tether FTP server', `Root: ${ROOT}`],
  log: bunyan.createLogger({ name: 'ftp-srv', level: 'warn' }),
});

ftpServer.on('login', ({ username }, resolve, reject) => {
  if (username === 'anonymous' || username === 'ftp') {
    return resolve({ root: ROOT });
  }
  return reject(new Error('Only anonymous login is allowed'));
});

ftpServer.on('client-error', ({ context, error }) => {
  console.error(`[client-error] ${context}:`, error.message);
});

ftpServer
  .listen()
  .then(() => {
    console.log(`FTP server listening on ftp://${HOST}:${PORT}`);
    console.log(`Anonymous login enabled. Serving: ${ROOT}`);
    console.log(`PASV advertised: ${PASV_URL}:${PASV_MIN}-${PASV_MAX}`);
  })
  .catch((err) => {
    console.error('Failed to start FTP server:', err);
    process.exit(1);
  });

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down...`);
  ftpServer.close().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
