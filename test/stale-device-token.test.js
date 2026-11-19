import assert from 'node:assert/strict'
import test from 'node:test'

const OLD_TOKEN = 'aaaa0000'
const NEW_TOKEN = 'bbbb1111'
const DEVICE_KEY = 'testdevicekey'

class FakeD1Database {
    constructor() {
        this.devices = new Map()
    }

    exec() {}

    prepare(query) {
        return {
            bind: (...bindings) => ({ run: async () => this.run(query, bindings) }),
            run: async () => this.run(query, []),
        }
    }

    async run(query, bindings) {
        if (query.startsWith('SELECT `token` FROM `devices`')) {
            return { results: this.devices.has(bindings[0]) ? [{ token: this.devices.get(bindings[0]) }] : [] }
        }

        if (query.startsWith('INSERT INTO `devices`')) {
            this.devices.set(bindings[0], bindings[1])
        }

        if (query.startsWith('UPDATE `devices` SET `token` = \'\'')) {
            if (this.devices.get(bindings[0]) === bindings[1]) {
                this.devices.set(bindings[0], '')
            }
        }

        if (query.startsWith('SELECT `token`, `time` FROM `authorization`')) {
            return { results: [{ token: 'test-authorization-token', time: String(Math.floor(Date.now() / 1000)) }] }
        }

        return { results: [] }
    }

    token(key) { return this.devices.get(key) }
    setToken(key, token) { this.devices.set(key, token) }
}

class FakeKVNamespace {
    constructor() {
        this.values = new Map()
    }

    async get(key, type) {
        if (key === '_authToken_') {
            return { token: 'test-authorization-token', time: Math.floor(Date.now() / 1000) }
        }

        return this.values.has(key) ? this.values.get(key) : null
    }

    async put(key, value) { this.values.set(key, value) }
    async delete(key) { this.values.delete(key) }

    token(key) { return this.values.get(key) }
    setToken(key, token) { this.values.set(key, token) }
}

async function createHarness(modulePath, database, name) {
    // A fresh module instance, so the in-memory cache starts empty
    const { default: worker } = await import(`${modulePath}?stale=${name}`)
    const pushedTokens = []
    const acceptedTokens = new Set()

    const push = async () => {
        const originalFetch = globalThis.fetch

        globalThis.fetch = async (url) => {
            const token = url.split('/').pop()
            pushedTokens.push(token)

            return acceptedTokens.has(token)
                ? new Response(null, { status: 200 })
                : new Response(JSON.stringify({ reason: 'Unregistered' }), { status: 410 })
        }

        try {
            const pending = []
            const response = await worker.fetch(new Request('https://worker.example/push', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ device_key: DEVICE_KEY, body: 'stale token' }),
            }), { database, ROOT_PATH: '/' }, { waitUntil: (promise) => pending.push(promise) })

            await Promise.all(pending)

            return response.status
        } finally {
            globalThis.fetch = originalFetch
        }
    }

    return { push, pushedTokens, acceptedTokens }
}

for (const [name, modulePath, createDatabase] of [
    ['D1', '../main.js', () => new FakeD1Database()],
    ['KV', '../main_kv.js', () => new FakeKVNamespace()],
]) {
    test(`${name}: a stale cached token does not wipe a newer registration`, async () => {
        const database = createDatabase()
        const { push, pushedTokens, acceptedTokens } = await createHarness(modulePath, database, `${name}-newer`)

        // This isolate caches the old token while APNs still accepts it
        database.setToken(DEVICE_KEY, OLD_TOKEN)
        acceptedTokens.add(OLD_TOKEN)
        assert.equal(await push(), 200)

        // The device registers a new token through another isolate
        database.setToken(DEVICE_KEY, NEW_TOKEN)
        acceptedTokens.clear()
        acceptedTokens.add(NEW_TOKEN)

        // The cached old token is rejected, but the new registration survives
        assert.equal(await push(), 410)
        assert.equal(pushedTokens.at(-1), OLD_TOKEN)
        assert.equal(database.token(DEVICE_KEY), NEW_TOKEN)

        // The cache was dropped, so the next push uses the new token
        assert.equal(await push(), 200)
        assert.equal(pushedTokens.at(-1), NEW_TOKEN)
    })

    test(`${name}: a token APNs rejects is still cleared when it is the stored one`, async () => {
        const database = createDatabase()
        const { push, pushedTokens } = await createHarness(modulePath, database, `${name}-current`)

        database.setToken(DEVICE_KEY, OLD_TOKEN)

        assert.equal(await push(), 410)
        assert.equal(pushedTokens.at(-1), OLD_TOKEN)
        assert.equal(database.token(DEVICE_KEY), '')

        // Same response as before the fix once the token is cleared
        assert.equal(await push(), 400)
    })
}
