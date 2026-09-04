import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { NextFunction, Request, Response } from 'express';
import { logs } from '../controller/logs';
import AppError from '../utils/appError';

interface CapturedResponse {
	statusCode: number;
	body?: unknown;
	contentType?: string;
}

type LogsHandler = (req: Request, res: Response, next: NextFunction) => unknown;

const expectedLogFilePath = resolve(__dirname, '../../logs/app.log');
const originalReadFile = fs.readFile;

function createResponse(captured: CapturedResponse): Response {
	return {
		status(code: number) {
			captured.statusCode = code;
			return this;
		},
		type(contentType: string) {
			captured.contentType = contentType;
			return this;
		},
		set(field: string, value?: string) {
			if (field.toLowerCase() === 'content-type' && value) {
				captured.contentType = value;
			}
			return this;
		},
		setHeader(field: string, value: string | number | readonly string[]) {
			if (field.toLowerCase() === 'content-type') {
				captured.contentType = String(value);
			}
			return this;
		},
		send(body?: unknown) {
			captured.body = body;
			return this;
		},
		json(body?: unknown) {
			captured.body = body;
			return this;
		}
	} as unknown as Response;
}

async function invokeLogs(body: unknown): Promise<{
	response: CapturedResponse;
	nextError?: unknown;
}> {
	const response: CapturedResponse = { statusCode: 200 };
	let nextError: unknown;
	const next = ((error?: unknown) => {
		nextError = error;
	}) as NextFunction;
	const handler = logs as unknown as LogsHandler;
	const result = handler({ body } as Request, createResponse(response), next);

	await Promise.resolve(result);

	return { response, nextError };
}

function mockReadFile(
	implementation: (path: unknown, encoding: unknown) => Promise<string>
): void {
	fs.readFile = implementation as typeof fs.readFile;
}

describe('logs controller', () => {
	afterEach(() => {
		fs.readFile = originalReadFile;
	});

	it('should return only exact deployment records in their original order', async () => {
		const allLogs =
			'2026-09-02T10:00:00.000Z - app | first line\ncontinued line\n\n' +
			'2026-09-02T10:00:01.000Z - app-2 | private output\n' +
			'2026-09-02T10:00:02.000Z - my-app | other output\n' +
			'2026-09-02T10:00:03.000Z - app | second line\n';
		const expected =
			'2026-09-02T10:00:00.000Z - app | first line\ncontinued line\n\n' +
			'2026-09-02T10:00:03.000Z - app | second line\n';
		const readCalls: Array<[unknown, unknown]> = [];
		mockReadFile((path, encoding) => {
			readCalls.push([path, encoding]);
			return Promise.resolve(allLogs);
		});

		const { response, nextError } = await invokeLogs({
			container: 'node',
			type: 'deploy',
			suffix: 'app',
			prefix: 'local-host',
			version: 'v1'
		});

		assert.strictEqual(nextError, undefined);
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body, expected);
		assert.match(response.contentType || '', /^text\/plain/);
		assert.deepStrictEqual(readCalls, [[expectedLogFilePath, 'utf-8']]);
	});

	it('should return an empty body when the log file is empty', async () => {
		mockReadFile(() => Promise.resolve(''));

		const { response, nextError } = await invokeLogs({ suffix: 'app' });

		assert.strictEqual(nextError, undefined);
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body, '');
	});

	it('should return an empty body when the deployment has no log records', async () => {
		mockReadFile(() =>
			Promise.resolve('2026-09-02T10:00:00.000Z - another-app | output\n')
		);

		const { response, nextError } = await invokeLogs({ suffix: 'app' });

		assert.strictEqual(nextError, undefined);
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body, '');
	});

	it('should return an empty body when the log file does not exist', async () => {
		const error = Object.assign(new Error('file does not exist'), {
			code: 'ENOENT'
		});
		mockReadFile(() => Promise.reject(error));

		const { response, nextError } = await invokeLogs({ suffix: 'app' });

		assert.strictEqual(nextError, undefined);
		assert.strictEqual(response.statusCode, 200);
		assert.strictEqual(response.body, '');
	});

	const invalidBodies: Array<{ name: string; body: unknown }> = [
		{ name: 'undefined body', body: undefined },
		{ name: 'null body', body: null },
		{ name: 'primitive body', body: 'app' },
		{ name: 'missing suffix', body: {} },
		{ name: 'non-string suffix', body: { suffix: 42 } },
		{ name: 'empty suffix', body: { suffix: '' } },
		{ name: 'whitespace-only suffix', body: { suffix: '   ' } }
	];

	for (const { name, body } of invalidBodies) {
		it(`should reject ${name} without reading the log file`, async () => {
			let readCount = 0;
			mockReadFile(() => {
				readCount += 1;
				return Promise.resolve('');
			});

			const { response, nextError } = await invokeLogs(body);

			assert.ok(nextError instanceof AppError);
			assert.strictEqual(nextError.statusCode, 400);
			assert.strictEqual(
				nextError.message,
				'A deployment name (suffix) is required.'
			);
			assert.strictEqual(response.body, undefined);
			assert.strictEqual(readCount, 0);
		});
	}

	it('should forward a sanitized server error when the log file cannot be read', async () => {
		const originalMessage =
			'EACCES: permission denied, open /private/faas/app.log';
		const error = Object.assign(new Error(originalMessage), {
			code: 'EACCES'
		});
		mockReadFile(() => Promise.reject(error));

		const { response, nextError } = await invokeLogs({ suffix: 'app' });

		assert.ok(nextError instanceof AppError);
		assert.strictEqual(nextError.statusCode, 500);
		assert.strictEqual(
			nextError.message,
			'Unable to read deployment logs.'
		);
		assert.ok(!nextError.message.includes(originalMessage));
		assert.strictEqual(response.body, undefined);
	});
});
