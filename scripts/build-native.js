// Builds main/native/syshelper.exe from syshelper.cs when it is missing or
// older than its source (or always, with --force). It uses the C# compiler
// that ships with Windows, so no extra tools are needed.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'main', 'native');
const exe = path.join(dir, 'syshelper.exe');
const src = path.join(dir, 'syshelper.cs');

if (process.platform !== 'win32') {
  console.log('syshelper: skipped (Windows only)');
  process.exit(0);
}

const force = process.argv.includes('--force');
const stale = !fs.existsSync(exe) || fs.statSync(exe).mtimeMs < fs.statSync(src).mtimeMs;
if (!force && !stale) process.exit(0);

console.log('Building main/native/syshelper.exe ...');
try {
  execSync(`"${path.join(dir, 'build.cmd')}"`, { stdio: 'inherit' });
} catch {
  console.error('\nCould not build syshelper.exe. It needs the .NET Framework 4 C# compiler,');
  console.error('which ships with Windows (C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe).');
  process.exit(1);
}
if (!fs.existsSync(exe)) {
  console.error('syshelper.exe was not created.');
  process.exit(1);
}
