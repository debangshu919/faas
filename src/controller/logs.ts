import { promises as fs } from 'fs';
import { resolve } from 'path';
import { NextFunction, Request, Response } from 'express';
import AppError from '../utils/appError';
import { catchAsync } from './catch';

const logFilePath = resolve(__dirname, '../../logs/app.log');

function deploymentLogs(contents: string, suffix: string): string {
	const logHeader =
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z - ([^|\r\n]+) \|/gm;
	const records: Array<{ index: number; deployment: string }> = [];
	let match: RegExpExecArray | null;

	while ((match = logHeader.exec(contents)) !== null) {
		records.push({ index: match.index, deployment: match[1] });
	}

	return records
		.filter(record => record.deployment === suffix)
		.map(record => {
			const recordIndex = records.indexOf(record);
			const nextRecord = records[recordIndex + 1];
			return contents.slice(
				record.index,
				nextRecord?.index ?? contents.length
			);
		})
		.join('');
}

function errorCode(error: unknown): unknown {
	if (typeof error !== 'object' || error === null || !('code' in error)) {
		return undefined;
	}

	return (error as { code: unknown }).code;
}

export const logs = catchAsync(
	async (req: Request, res: Response, next: NextFunction) => {
		const body = req.body as unknown;
		const suffix =
			typeof body === 'object' && body !== null && 'suffix' in body
				? (body as { suffix: unknown }).suffix
				: undefined;

		if (typeof suffix !== 'string' || suffix.trim() === '') {
			return next(
				new AppError('A deployment name (suffix) is required.', 400)
			);
		}

		try {
			const contents = await fs.readFile(logFilePath, 'utf-8');
			return res
				.status(200)
				.type('text/plain')
				.send(deploymentLogs(contents, suffix));
		} catch (error) {
			if (errorCode(error) === 'ENOENT') {
				return res.status(200).type('text/plain').send('');
			}

			return next(new AppError('Unable to read deployment logs.', 500));
		}
	}
);
