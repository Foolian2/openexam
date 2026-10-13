#!/usr/bin/env node
// Provision backup keys and a recovery sheet without changing live archiving.
// Run through scripts/setup-walg-sftp.sh, which builds the Dockerfile's
// walg-setup stage, so the production host needs no Node or node_modules.
import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, chown, unlink, rename } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import React from 'react'
import { Document, Page, Text, Image, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import QRCode from 'qrcode'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 3 || args.includes('--help')) {
  console.error('Usage: scripts/setup-walg-sftp.sh HOST USER /REMOTE/DIRECTORY')
  console.error('Creates keys and a recovery PDF. Does not deploy or change archive_command.')
  process.exit(args.includes('--help') ? 0 : 1)
}
const [host, user, remotePath] = args
if (!/^[a-zA-Z0-9.-]+$/.test(host) || !/^[a-zA-Z0-9_-]+$/.test(user) || !/^\/[a-zA-Z0-9_./-]+$/.test(remotePath)) {
  throw new Error('Use a hostname/IP, a plain username, and an absolute remote directory.')
}
const secrets = join(root, 'secrets')
// Paths as the operator sees them on the host (the wrapper bind-mounts secrets/).
const hostSecrets = process.env.HOST_SECRETS_DIR || secrets
// The Postgres and tunnel containers read the keys as uid 999. When run as
// root (the container), hand the private keys to that uid and the
// operator-facing files to the invoking host user.
const asRoot = process.getuid?.() === 0
const hostOwner = [Number(process.env.HOST_UID), Number(process.env.HOST_GID)]
async function own(path, [uid, gid]) {
  if (asRoot && Number.isInteger(uid) && Number.isInteger(gid)) await chown(path, uid, gid)
}
await mkdir(secrets, { recursive: true, mode: 0o700 })
await chmod(secrets, 0o700)
const keyPath = join(secrets, 'walg_libsodium_key')
const sshPath = join(secrets, 'walg_ssh_key')
const pdfPath = join(secrets, 'backup-recovery.pdf')
try {
  await writeFile(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
} catch (error) { if (error.code !== 'EEXIST') throw error }
const key = (await readFile(keyPath, 'utf8')).trim()
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Existing encryption key is invalid; refusing to replace it.')
await chmod(keyPath, 0o600)
await own(keyPath, [999, 999])
try { await readFile(sshPath) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'openexam-walg', '-f', sshPath], { stdio: 'inherit' })
}
await chmod(sshPath, 0o600)
await own(sshPath, [999, 999])
await own(sshPath + '.pub', hostOwner)
console.log('Install this public key on the SFTP destination:')
console.log((await readFile(sshPath + '.pub', 'utf8')).trim())
const fingerprint = createHash('sha256').update(key).digest('hex')
const savedPath = join(secrets, '.walg_key_saved')
const saved = await readFile(savedPath, 'utf8').then((text) => text.trim(), () => '')
if (saved === fingerprint) {
  // A rerun (or scripts/restore-walg-key.sh on a rebuilt host) already
  // recorded an off-host copy of this exact key; only the SSH key was needed.
  console.log('The recovery sheet for this encryption key is already acknowledged.')
  process.exit(0)
}
const code = randomBytes(6).toString('hex')
const styles = StyleSheet.create({ page: { padding: 45, fontSize: 11, lineHeight: 1.5 }, title: { fontSize: 22, marginBottom: 16 }, text: { marginBottom: 12 }, key: { fontFamily: 'Courier', fontSize: 13, marginBottom: 16 }, qr: { width: 140, height: 140 } })
const h = React.createElement
const qr = await QRCode.toDataURL(key, { errorCorrectionLevel: 'M', margin: 2 })
const document = h(Document, {}, h(Page, { size: 'A4', style: styles.page },
  h(Text, { style: styles.title }, 'OpenExam backup recovery'),
  h(Text, { style: styles.text }, `Created: ${new Date().toISOString()}\nDestination: ${user}@${host}:${remotePath}`),
  h(Text, { style: styles.text }, 'Keep this sheet outside the deployment host. Anyone with this key and the archive can read student data. Losing the key makes encrypted backups unrecoverable.'),
  h(Text, { style: styles.key }, key.match(/.{1,8}/g).join(' ')),
  h(Image, { src: qr, style: styles.qr }),
  h(Text, { style: styles.text }, `Confirmation code: ${code}`),
  h(Text, { style: styles.text }, 'Recovery on a rebuilt host: run scripts/restore-walg-key.sh and type the key above (spaces are ignored). It writes secrets/walg_libsodium_key and records this sheet as acknowledged. Then run scripts/setup-walg-sftp.sh with the destination above to create a new SSH credential, install its public key for the same archive, pin the host key, and set WALG_STORAGE_BACKEND=sftp. Fetch and replay into a scratch database first; do not run a destructive restore against production until verified.'),
  h(Text, { style: styles.text }, 'A successful restore drill is required before deleting the previous MinIO backup archive.')
))
// The file contains secrets; create it privately before rendering writes any bytes.
const temporaryPdf = `${pdfPath}.${randomBytes(6).toString('hex')}`
await writeFile(temporaryPdf, await renderToBuffer(document), { flag: 'wx', mode: 0o600 })
await rename(temporaryPdf, pdfPath)
await own(pdfPath, hostOwner)
console.log('Download the recovery PDF from another machine, for example:')
console.log(`scp DEPLOYMENT_USER@DEPLOYMENT_HOST:${join(hostSecrets, 'backup-recovery.pdf')} ./openexam-backup-recovery.pdf`)
console.log('Open it, save an off-host copy, and enter its confirmation code below.')
console.log('This confirms your acknowledgement; it cannot prove where the copy is stored.')
const input = createInterface({ input: process.stdin, output: process.stdout })
try {
  const answer = await input.question('Recovery sheet confirmation code: ')
  if (answer.trim() !== code) throw new Error('Confirmation failed. Keys and PDF preserved; no configuration enabled.')
  await writeFile(savedPath, fingerprint + '\n', { mode: 0o600 })
  await unlink(pdfPath)
  console.log('Recovery copy acknowledged. Local PDF removed; live backups are unchanged.')
  console.log('Next: verify the server host key, test encrypted upload/restore, then configure the cutover.')
} finally { input.close() }
