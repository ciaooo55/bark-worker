import assert from 'node:assert/strict'
import test from 'node:test'

class FakeD1Database {
    exec() {}

    prepare(query) {
        return {
            bind: () => ({ run: async () => this.run(query) }),
            run: async () => this.run(query),
        }
    }

    async run(query) {
        if (query.includes('SELECT `token` FROM `devices`')) {
            return { results: [{ token: 'test-device-token' }] }
        }

        // No stored authorization token, so the worker has to sign a new JWT
        return { results: [] }
    }
}

class FakeKVNamespace {
    async get(key) {
        return key === '_authToken_' ? null : 'test-device-token'
    }

    async put() {}
}

async function signedJWT(modulePath, database, index) {
    // A fresh module instance per call, so the in-memory token cache is empty
    const { default: worker } = await import(`${modulePath}?jwt=${index}`)
    const originalFetch = globalThis.fetch
    let authorization

    globalThis.fetch = async (url, init) => {
        authorization = init.headers.authorization
        return new Response(null, { status: 200 })
    }

    try {
        const pending = []
        const response = await worker.fetch(new Request('https://worker.example/push', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ device_key: 'testdevicekey', body: 'jwt' }),
        }), { database, ROOT_PATH: '/' }, { waitUntil: (promise) => pending.push(promise) })

        await Promise.all(pending)
        assert.equal(response.status, 200)
    } finally {
        globalThis.fetch = originalFetch
    }

    return authorization.replace(/^bearer /, '')
}

for (const [name, modulePath, createDatabase] of [
    ['D1', '../main.js', () => new FakeD1Database()],
    ['KV', '../main_kv.js', () => new FakeKVNamespace()],
]) {
    test(`${name}: APNs JWT is always valid base64url`, async () => {
        // ECDSA signatures are random: sign many times to cover signatures
        // whose base64 form holds several '+' or '/' characters
        for (let index = 0; index < 40; index++) {
            const jwt = await signedJWT(modulePath, createDatabase(), index)
            const parts = jwt.split('.')

            assert.equal(parts.length, 3)
            for (const part of parts) {
                assert.match(part, /^[A-Za-z0-9_-]+$/)
            }

            assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url').toString()), { alg: 'ES256', kid: 'LH4T9V5U4R' })
            assert.equal(Buffer.from(parts[2], 'base64url').length, 64)
        }
    })
}
