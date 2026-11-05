const modes = new Set(['standby', 'connecting', 'connected', 'disconnected']);

function createSharedControl(directory, port) {
	let memory = { mode: 'standby', revision: '' };
	let pending = Promise.resolve();
	let stamp;
	const filename = directory && require('node:path').join(directory, `bridge-control.${port}.json`);
	const fileStamp = async () => {
		try {
			const value = await require('node:fs/promises').stat(filename, { bigint: true });
			return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
		} catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
	};
	const readUnlocked = async () => {
		if (!filename) return memory;
		const fs = require('node:fs/promises');
		let value;
		try { value = JSON.parse(await fs.readFile(filename, 'utf8')); }
		catch (error) {
			if (error.code !== 'ENOENT') throw error;
			stamp = '';
			return memory = { mode: 'standby', revision: '' };
		}
		if (value.service !== 'genai-login' || value.version !== 1 || value.port !== port ||
			!modes.has(value.mode) || typeof value.revision !== 'string' || !value.revision) throw new Error('Invalid shared connection control');
		stamp = await fileStamp();
		return memory = { mode: value.mode, revision: value.revision };
	};
	const locked = operation => {
		const next = pending.catch(() => {}).then(async () => {
			const fs = filename && require('node:fs/promises');
			let lock;
			if (filename) {
				await fs.mkdir(directory, { recursive: true });
				for (let attempt = 0; ; attempt++) {
					try { lock = await fs.open(filename + '.lock', 'wx'); break; }
					catch (error) {
						if (error.code !== 'EEXIST' || attempt >= 40) throw error;
						try {
							if (Date.now() - (await fs.stat(filename + '.lock')).mtimeMs > 30000) await fs.unlink(filename + '.lock');
						} catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
						await require('node:timers/promises').setTimeout(25);
					}
				}
			}
			try { return await operation(); }
			finally {
				if (lock) { await lock.close(); await fs.unlink(filename + '.lock'); }
			}
		});
		pending = next;
		return next;
	};
	return {
		read: () => pending.catch(() => {}).then(async () => {
			if (!filename) return memory;
			const current = await fileStamp();
			if (stamp === current) return memory;
			if (!current) { stamp = ''; return memory = { mode: 'standby', revision: '' }; }
			return locked(readUnlocked);
		}),
		update(mode, expectedRevision) {
			if (!modes.has(mode)) return Promise.reject(new Error('Invalid shared connection mode'));
			return locked(async () => {
				const fs = filename && require('node:fs/promises');
				let temporary;
				try {
					const current = await readUnlocked();
					if (expectedRevision !== undefined && current.revision !== expectedRevision) return undefined;
					const next = { mode, revision: require('node:crypto').randomUUID() };
					if (filename) {
						temporary = filename + '.' + next.revision + '.tmp';
						await fs.writeFile(temporary, JSON.stringify({ service: 'genai-login', version: 1, port, ...next }), { flag: 'wx' });
						for (let attempt = 0; ; attempt++) {
							try { await fs.rename(temporary, filename); break; }
							catch (error) {
								if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
								await require('node:timers/promises').setTimeout(10 * (attempt + 1));
							}
						}
						stamp = await fileStamp();
					}
					memory = next;
					return next;
				} finally {
					if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
				}
			});
		}
	};
}

function requestSharedState(port, command, { headers, signal } = {}) {
	if (!['status', 'connect', 'disconnect'].includes(command)) return Promise.reject(new Error('Invalid shared command'));
	return new Promise((resolve, reject) => {
		const request = require('node:http').request({ hostname: '127.0.0.1', port,
			path: `/internal/${command}`, method: command === 'status' ? 'GET' : 'POST', agent: false, signal,
			headers: { Authorization: 'Bearer local-browser-session', ...headers }
		}, response => {
			response.on('error', reject);
			if (response.statusCode < 200 || response.statusCode >= 300) {
				response.destroy();
				return reject(Object.assign(new Error('Shared connection control failed'), { code: 'SHARED_CONTROL_FAILED', status: response.statusCode }));
			}
			const chunks = [];
			let size = 0;
			response.on('data', chunk => {
				size += chunk.length;
				if (size > 256 * 1024) {
					response.destroy(new Error('Shared response too large'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
				catch (error) { reject(error); }
			});
		});
		request.on('error', reject);
		request.end();
	});
}

module.exports = { createSharedControl, requestSharedState };