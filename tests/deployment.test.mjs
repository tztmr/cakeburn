import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shell = process.env.BASH || "bash";
const mockTool = `#!${process.execPath}
import { appendFileSync, cpSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'uname') { console.log('Linux'); }
else if (command === 'docker') {
  if (args[0] === 'compose') {
    if (args.includes('build') && process.env.MOCK_FAIL_BUILD) process.exit(42);
    if (args.includes('ps') && args.includes('-q')) console.log('cakeburn-container');
  }
  if (args[0] === 'inspect') console.log(process.env.MOCK_HEALTH || 'running/healthy');
}
else if (command === 'git') {
  if (args[0] === 'clone') {
    const target = args.at(-1);
    cpSync(process.env.MOCK_SOURCE, target, { recursive: true });
    mkdirSync(target + '/.git', { recursive: true });
  }
  if (args.includes('status') && process.env.MOCK_DIRTY) console.log(' M app/page.tsx');
}
else if (command === 'curl') { console.log('{"status":"ok","service":"cakeburn"}'); }
else if (command === 'ufw') { console.log('Status: inactive'); }
else if (command === 'firewall-cmd') { process.exit(1); }
else if (command !== 'sleep') { throw new Error('Unexpected system mutation: ' + command); }
`;

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "cakeburn-deploy-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const home = join(path, "home");
  const tools = join(path, "tools");
  const download = join(path, "download");
  const source = join(path, "source");
  const installed = join(path, "安装 dir ' $literal `literal`");
  for (const dir of [home, tools, download, source]) mkdirSync(dir);
  cpSync(join(root, "cakeburn.sh"), join(download, "cakeburn.sh"));
  for (const file of ["cakeburn.sh", ".env.example", "docker-compose.yml", "Dockerfile", "Caddyfile", "package.json"]) {
    cpSync(join(root, file), join(source, file));
  }
  for (const name of ["docker", "git", "uname", "curl", "sleep", "ufw", "firewall-cmd", "sudo", "systemctl", "apt-get", "dnf", "yum"]) {
    writeFileSync(join(tools, name), mockTool, { mode: 0o755 });
  }
  const log = join(path, "commands.jsonl");
  const env = { ...process.env, HOME: home, PATH: `${tools}:${process.env.PATH}`, MOCK_LOG: log, MOCK_SOURCE: source };
  for (const key of ["CAKEBURN_PORT", "CAKEBURN_BIND", "CAKEBURN_BRANCH", "CAKEBURN_REPO_URL", "CAKEBURN_STATE_DIR", "CAKEBURN_INSTALL_DIR", "MOCK_DIRTY", "MOCK_FAIL_BUILD", "MOCK_HEALTH"]) delete env[key];
  const execute = (args, extraEnv = {}) => spawnSync(shell, [join(download, "cakeburn.sh"), ...args], {
    cwd: download, encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 15000,
  });
  const commands = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const clear = () => { if (existsSync(log)) writeFileSync(log, ""); };
  const deploy = (...args) => execute(["deploy", "--yes", "--install-dir", installed, ...args]);
  const state = join(home, ".cakeburn", "project-dir");
  return { path, home, installed, log, env, execute, deploy, state, commands, clear };
}

function succeeded(result) {
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
}
function composeCommands(f) { return f.commands().filter(entry => entry.command === "docker" && entry.args[0] === "compose"); }

test("standalone dry-run plans a clone without writing files or invoking system tools", t => {
  const f = fixture(t);
  const result = f.execute(["--dry-run", "deploy", "--yes", "--install-dir", f.installed, "--port", "8080"]);
  succeeded(result);
  assert.match(result.stdout, /git clone/);
  assert.match(result.stdout, /CAKEBURN_PORT=8080/);
  assert.match(result.stdout, /build --pull cakeburn/);
  assert.equal(existsSync(f.installed), false);
  assert.deepEqual(readdirSync(f.home), []);
  assert.deepEqual(f.commands(), []);
});

test("bootstrap accepts literal paths and management finds its saved installation", t => {
  const f = fixture(t);
  succeeded(f.deploy("--port", "08080"));
  assert.equal(readFileSync(f.state, "utf8"), `${f.installed}\n`);
  assert.match(readFileSync(join(f.installed, ".env"), "utf8"), /^CAKEBURN_PORT=8080$/m);
  assert.equal(f.commands().filter(entry => entry.command === "git" && entry.args[0] === "clone").length, 1);
  f.clear();
  succeeded(f.execute(["status"]));
  const status = composeCommands(f).find(entry => entry.args.includes("ps"));
  assert.ok(status.args.includes(f.installed));
  assert.equal(f.commands().some(entry => ["apt-get", "sudo", "systemctl"].includes(entry.command)), false);
});

test("redeploy preserves existing configuration and never evaluates .env contents", t => {
  const f = fixture(t);
  succeeded(f.deploy());
  const marker = join(f.path, "must-not-exist");
  const config = `CAKEBURN_PORT=8765\nCAKEBURN_BIND=127.0.0.1\nCAKEBURN_DOMAIN=\nSITE_URL=\nOTHER=$(touch '${marker}')\n`;
  writeFileSync(join(f.installed, ".env"), config);
  f.clear();
  succeeded(f.deploy());
  assert.equal(readFileSync(join(f.installed, ".env"), "utf8"), config);
  assert.equal(existsSync(marker), false);
  assert.equal(f.commands().some(entry => entry.command === "git" && entry.args[0] === "clone"), false);
});

test("invalid ports, domains and unrelated installation directories fail without overwriting", t => {
  const f = fixture(t);
  for (const port of ["0", "65536", "-1", "3000;touch pwned", "1e3"]) {
    assert.notEqual(f.deploy("--port", port).status, 0, port);
  }
  for (const domain of ["https://cake.example.com", "*.example.com", "example.com/", "-bad.example", "a..example.com", "127.0.0.1", "example.com."]) {
    assert.notEqual(f.execute(["enable-ssl", "--domain", domain]).status, 0, domain);
  }
  assert.equal(existsSync(f.installed), false);
  mkdirSync(f.installed);
  writeFileSync(join(f.installed, "keep.txt"), "existing data");
  assert.notEqual(f.deploy().status, 0);
  assert.equal(readFileSync(join(f.installed, "keep.txt"), "utf8"), "existing data");
  assert.equal(f.commands().some(entry => entry.command === "git" && entry.args[0] === "clone"), false);
});

test("a failed build leaves the running service and previous deployment state alone", t => {
  const f = fixture(t);
  succeeded(f.deploy());
  const state = readFileSync(f.state, "utf8");
  f.clear();
  const result = f.execute(["deploy", "--yes"], { MOCK_FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(f.state, "utf8"), state);
  assert.equal(composeCommands(f).some(entry => entry.args.includes("up") || entry.args.includes("down") || entry.args.includes("stop")), false);
  assert.doesNotMatch(result.stdout, /服务已启动/);
});

test("an unhealthy container produces logs and an error instead of a success message", t => {
  const f = fixture(t);
  const result = f.execute(["deploy", "--yes", "--install-dir", f.installed], { MOCK_HEALTH: "exited/unhealthy" });
  assert.notEqual(result.status, 0);
  assert.ok(composeCommands(f).some(entry => entry.args.includes("logs")));
  assert.doesNotMatch(result.stdout, /服务已启动/);
});

test("update refuses dirty sources and otherwise uses fast-forward pull while keeping config", t => {
  const f = fixture(t);
  succeeded(f.deploy("--port", "8081"));
  const config = readFileSync(join(f.installed, ".env"), "utf8");
  f.clear();
  assert.notEqual(f.execute(["update"], { MOCK_DIRTY: "1" }).status, 0);
  assert.equal(f.commands().some(entry => entry.args.includes("pull") || entry.args.includes("build")), false);
  f.clear();
  succeeded(f.execute(["update"]));
  assert.ok(f.commands().some(entry => entry.command === "git" && entry.args.includes("pull") && entry.args.includes("--ff-only")));
  assert.equal(readFileSync(join(f.installed, ".env"), "utf8"), config);
});

test("HTTPS records the domain, enables Caddy and binds the application to loopback", t => {
  const f = fixture(t);
  succeeded(f.deploy());
  f.clear();
  succeeded(f.execute(["enable-ssl", "--domain", "Cake.Example.com"]));
  const config = readFileSync(join(f.installed, ".env"), "utf8");
  assert.match(config, /^CAKEBURN_DOMAIN=cake.example.com$/m);
  assert.match(config, /^CAKEBURN_BIND=127\.0\.0\.1$/m);
  assert.match(config, /^SITE_URL=https:\/\/cake\.example\.com$/m);
  assert.ok(composeCommands(f).filter(entry => entry.args.includes("up")).every(entry => entry.args.includes("--profile") && entry.args.includes("https")));
  const unchanged = readFileSync(join(f.installed, ".env"), "utf8");
  f.clear();
  succeeded(f.execute(["enable-ssl", "--dry-run", "--domain", "new.example.com"]));
  assert.equal(readFileSync(join(f.installed, ".env"), "utf8"), unchanged);
  assert.deepEqual(f.commands(), []);
});

test("HTTPS refuses application ports 80 and 443 before changing configuration", t => {
  const f = fixture(t);
  succeeded(f.deploy("--port", "80"));
  const config = readFileSync(join(f.installed, ".env"), "utf8");
  f.clear();
  assert.notEqual(f.execute(["enable-ssl", "--domain", "cake.example.com"]).status, 0);
  assert.equal(readFileSync(join(f.installed, ".env"), "utf8"), config);
  assert.equal(composeCommands(f).some(entry => entry.args.includes("build") || entry.args.includes("up")), false);
});

test("uninstall requires explicit noninteractive consent and preserves config and volumes", t => {
  const f = fixture(t);
  succeeded(f.deploy());
  f.clear();
  assert.notEqual(f.execute(["uninstall"]).status, 0);
  assert.equal(composeCommands(f).some(entry => entry.args.includes("down")), false);
  f.clear();
  succeeded(f.execute(["uninstall", "--dry-run"]));
  assert.ok(existsSync(f.state));
  assert.deepEqual(f.commands(), []);
  succeeded(f.execute(["uninstall", "--yes"]));
  const down = composeCommands(f).find(entry => entry.args.includes("down"));
  assert.ok(down);
  assert.equal(down.args.some(arg => ["-v", "--volumes", "--rmi"].includes(arg)), false);
  assert.ok(existsSync(join(f.installed, ".env")));
  assert.ok(existsSync(join(f.installed, "cakeburn.sh")));
  assert.equal(existsSync(f.state), false);
});
