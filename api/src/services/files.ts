import { ItemsService } from './items';
import storage from '../storage';
import sharp from 'sharp';
import { parse as parseICC } from 'icc';
import parseEXIF from 'exif-reader';
import parseIPTC from '../utils/parse-iptc';
import { AbstractServiceOptions, File, PrimaryKey } from '../types';
import { clone } from 'lodash';
import cache from '../cache';
import { ForbiddenException } from '../exceptions';
import { toArray } from '../utils/to-array';
import { extension } from 'mime-types';
import path from 'path';
import env from '../env';
import logger from '../logger';
import { extractThumbnailToBuffer } from '@spectrum/xd-thumbnail-extractor';
import { Duplex } from 'stream';

export class FilesService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_files', options);
	}

	async upload(
		stream: NodeJS.ReadableStream,
		data: Partial<File> & { filename_download: string; storage: string },
		primaryKey?: PrimaryKey
	) {
		const payload = clone(data);

		if (primaryKey !== undefined) {
			// If the file you're uploading already exists, we'll consider this upload a replace. In that case, we'll
			// delete the previously saved file and thumbnails to ensure they're generated fresh
			const disk = storage.disk(payload.storage);

			for await (const file of disk.flatList(String(primaryKey))) {
				await disk.delete(file.path);
			}

			await this.update(payload, primaryKey);
		} else {
			primaryKey = await this.create(payload);
		}

		const fileExtension = (payload.type && extension(payload.type)) || path.extname(payload.filename_download);

		payload.filename_disk = primaryKey + '.' + fileExtension;

		if (!payload.type) {
			payload.type = 'application/octet-stream';
		}

		if (['image/jpeg', 'image/png', 'image/webp'].includes(payload.type)) {
			const pipeline = sharp();

			pipeline
				.metadata()
				.then((meta) => {
					payload.width = meta.width;
					payload.height = meta.height;
					payload.filesize = meta.size;
					payload.metadata = {};

					if (meta.icc) {
						try {
							payload.metadata.icc = parseICC(meta.icc);
						} catch (err) {
							logger.warn(`Couldn't extract ICC information from file`);
							logger.warn(err);
						}
					}

					if (meta.exif) {
						try {
							payload.metadata.exif = parseEXIF(meta.exif);
						} catch (err) {
							logger.warn(`Couldn't extract EXIF information from file`);
							logger.warn(err);
						}
					}

					if (meta.iptc) {
						try {
							payload.metadata.iptc = parseIPTC(meta.iptc);
							payload.title = payload.title || payload.metadata.iptc.headline;
							payload.description = payload.description || payload.metadata.iptc.caption;
						} catch (err) {
							logger.warn(`Couldn't extract IPTC information from file`);
							logger.warn(err);
						}
					}
				})
				.catch((err) => {
					logger.warn(`Couldn't extract file metadata from ${payload.filename_disk}`);
					logger.warn(err);
				});
			try {
				await storage.disk(data.storage).put(payload.filename_disk, stream.pipe(pipeline));
			} catch (err) {
				logger.warn(`Couldn't save file ${payload.filename_disk}`);
				logger.warn(err);
			}
		} else {
			try {
				await storage.disk(data.storage).put(payload.filename_disk, stream);
			} catch (err) {
				logger.warn(`Couldn't save file ${payload.filename_disk}`);
				logger.warn(err);
			}

			// Try to extract the thumbnail from XD file without loading it into memory.
			if ('application/octet-stream' === payload.type && path.extname(payload.filename_download) === '.xd') {
				// Get Readable for XD asset
				const fileStream = await storage.disk(data.storage).getStream(payload.filename_disk);
				// Extract thumbnail buffer from XD asset
				const thumbnailBuffer = await extractThumbnailToBuffer(fileStream);
				// Create Readable for thumbnail
				const tmpReadableStream = new Duplex();
				tmpReadableStream.push(thumbnailBuffer);
				tmpReadableStream.push(null); // End the buffer based readable stream
				// Save the thumbnail with the same base name of original filename_disk and png as extension name
				await storage
					.disk(data.storage)
					.put(`${path.basename(payload.filename_disk, path.extname(payload.filename_disk))}.png`, tmpReadableStream);
				logger.info(
					`Thumbnail ${path.basename(
						payload.filename_disk,
						path.extname(payload.filename_disk)
					)}.png generated for XD asset ${payload.filename_download}`
				);
			}

			const { size } = await storage.disk(data.storage).getStat(payload.filename_disk);
			payload.filesize = size;
		}

		// We do this in a service without accountability. Even if you don't have update permissions to the file,
		// we still want to be able to set the extracted values from the file on create
		const sudoService = new ItemsService('directus_files', {
			knex: this.knex,
			schema: this.schema,
		});
		await sudoService.update(payload, primaryKey);

		if (cache && env.CACHE_AUTO_PURGE) {
			await cache.clear();
		}

		return primaryKey;
	}

	delete(key: PrimaryKey): Promise<PrimaryKey>;
	delete(keys: PrimaryKey[]): Promise<PrimaryKey[]>;
	async delete(key: PrimaryKey | PrimaryKey[]): Promise<PrimaryKey | PrimaryKey[]> {
		const keys = toArray(key);
		let files = await super.readByKey(keys, { fields: ['id', 'storage'] });

		if (!files) {
			throw new ForbiddenException();
		}

		await super.delete(keys);

		files = toArray(files);

		for (const file of files) {
			const disk = storage.disk(file.storage);

			// Delete file + thumbnails
			for await (const { path } of disk.flatList(file.id)) {
				await disk.delete(path);
			}
		}

		if (cache && env.CACHE_AUTO_PURGE) {
			await cache.clear();
		}

		return key;
	}
}
