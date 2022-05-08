/* eslint-disable @typescript-eslint/no-unused-vars */
import assert from 'assert';
import buildDebug from 'debug';
import _, { isNil } from 'lodash';
import { PassThrough, Readable, Stream, Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';

import { hasProxyTo } from '@verdaccio/config';
import {
  API_ERROR,
  API_MESSAGE,
  HTTP_STATUS,
  errorUtils,
  pkgUtils,
  pluginUtils,
  searchUtils,
  validatioUtils,
} from '@verdaccio/core';
import { logger } from '@verdaccio/logger';
import { IProxy, ISyncUplinksOptions, ProxyList, ProxyStorage } from '@verdaccio/proxy';
import {
  Author,
  Callback,
  CallbackAction,
  Config,
  DistFile,
  GenericBody,
  IPackageStorage,
  IReadTarball,
  IUploadTarball,
  Logger,
  Manifest,
  MergeTags,
  Package,
  StringValue,
  Token,
  TokenFilter,
  Version,
} from '@verdaccio/types';
import { createTarballHash, getLatestVersion, normalizeContributors } from '@verdaccio/utils';

import {
  PublishOptions,
  UpdateManifestOptions,
  cleanUpReadme,
  isDeprecatedManifest,
  tagVersion,
} from '.';
import { LocalStorage } from './local-storage';
import { SearchManager } from './search';
import { isPublishablePackage } from './star-utils';
import {
  STORAGE,
  checkPackageLocal,
  cleanUpLinksRef,
  generatePackageTemplate,
  generateRevision,
  mergeUplinkTimeIntoLocal,
  mergeUplinkTimeIntoLocalNext,
  mergeVersions,
  normalizeDistTags,
  normalizePackage,
  publishPackage,
  updateUpLinkMetadata,
} from './storage-utils';
import { IGetPackageOptions, IGetPackageOptionsNext, IPluginFilters, ISyncUplinks } from './type';
import {
  ProxyInstanceList,
  setupUpLinks,
  updateVersionsHiddenUpLink,
  updateVersionsHiddenUpLinkNext,
} from './uplink-util';

const debug = buildDebug('verdaccio:storage:abstract');

export const noSuchFile = 'ENOENT';
export const resourceNotAvailable = 'EAGAIN';
export const PROTO_NAME = '__proto__';

class AbstractStorage {
  public localStorage: LocalStorage;
  public searchManager: SearchManager | null;
  public filters: IPluginFilters;
  public readonly config: Config;
  public readonly logger: Logger;
  public readonly uplinks: ProxyInstanceList;
  public constructor(config: Config) {
    this.config = config;
    this.uplinks = setupUpLinks(config);
    this.logger = logger.child({ module: 'storage' });
    this.filters = [];
    // @ts-ignore
    this.localStorage = null;
    this.searchManager = null;
  }

  /**
   * Initialize the storage asyncronously.
   * @param config Config
   * @param filters IPluginFilters
   * @returns Storage instance
   */
  public async init(config: Config, filters: IPluginFilters = []): Promise<void> {
    if (this.localStorage === null) {
      this.filters = filters || [];
      debug('filters available %o', filters);
      this.localStorage = new LocalStorage(this.config, logger);
      await this.localStorage.init();
      debug('local init storage initialized');
      await this.localStorage.getSecret(config);
      debug('local storage secret initialized');
      this.searchManager = new SearchManager(this.uplinks, this.localStorage);
    } else {
      debug('storage has been already initialized');
    }
    return;
  }

  /**
   * Retrieve a wrapper that provide access to the package location.
   * @param {Object} pkgName package name.
   * @return {Object}
   */
  private getPrivatePackageStorage(pkgName: string): IPackageStorage {
    debug('get local storage for %o', pkgName);
    return this.localStorage.getStoragePlugin().getPackageStorage(pkgName);
  }

  /**
   * Create a tarball stream from a package.
   * @param name
   * @param filename
   * @param options
   * @returns
   */
  public async getLocalTarball(
    name: string,
    filename: string,
    { signal }: { signal: AbortSignal }
  ): Promise<Readable> {
    assert(validatioUtils.validateName(filename));
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);
    if (typeof storage === 'undefined') {
      return this.createFailureStreamResponseNext();
    }

    return await storage.readTarballNext(filename, { signal });
  }

  /**
   * Get a package local manifest
   * @param name package name
   * @returns local manifest
   */
  public async getPackageLocalMetadata(name: string): Promise<Manifest> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);
    debug('get package metadata for %o', name);
    if (typeof storage === 'undefined') {
      throw errorUtils.getNotFound();
    }

    try {
      const result: Manifest = await storage.readPackageNext(name);
      return normalizePackage(result);
    } catch (err: any) {
      if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
        debug('package %s not found', name);
        throw errorUtils.getNotFound();
      }
      this.logger.error(
        { err: err, file: STORAGE.PACKAGE_FILE_NAME },
        `error reading  @{file}: @{!err.message}`
      );

      throw errorUtils.getInternalError();
    }
  }

  /**
   * Fail the stream response with an not found error.
   * @returns
   */
  private createFailureStreamResponseNext(): PassThrough {
    const stream: PassThrough = new PassThrough();

    // we ensure fails on the next tick into the event loop
    process.nextTick((): void => {
      stream.emit('error', errorUtils.getNotFound(API_ERROR.NO_SUCH_FILE));
    });

    return stream;
  }

  public readTokens(filter: TokenFilter): Promise<Token[]> {
    return this.localStorage.readTokens(filter);
  }

  public saveToken(token: Token): Promise<void> {
    return this.localStorage.saveToken(token);
  }

  public deleteToken(user: string, tokenKey: string): Promise<any> {
    return this.localStorage.deleteToken(user, tokenKey);
  }

  /**
   * Tags a package version with a provided tag
     Used storages: local (write)
   */
  public mergeTags(name: string, tagHash: MergeTags, callback: CallbackAction): void {
    debug('merge tags for package %o tags %o', name, tagHash);
    this.localStorage.mergeTags(name, tagHash, callback);
  }

  public async fetchTarllballFromUpstream(
    pkgName: string,
    distFile: DistFile
  ): Promise<PassThrough> {
    let uplink: ProxyStorage | null = null;

    for (const uplinkId in this.uplinks) {
      // https://github.com/verdaccio/verdaccio/issues/1642
      if (hasProxyTo(pkgName, uplinkId, this.config.packages)) {
        // uplink = this.uplinks[uplinkId];
      }
    }

    if (uplink == null) {
      uplink = new ProxyStorage(
        {
          url: distFile.url,
          cache: true,
          _autogenerated: true,
        },
        this.config
      );
    }

    if (uplink.config?.cache) {
      // TODO: we save tarball into the cache
    }

    return uplink.fetchTarballNext(distFile.url, {});
  }

  public async updateLocalMetadata(pkgName: string) {
    const storage = this.getPrivatePackageStorage(pkgName);

    if (!storage) {
      throw errorUtils.getNotFound();
    }
  }

  public async updateManifest(manifest: Manifest, options: UpdateManifestOptions): Promise<Stream> {
    let stream;
    if (isDeprecatedManifest(manifest)) {
      // if the manifest is deprecated, we need to update the package.json
      stream = await this.deprecate(manifest, {
        ...options,
      });
    } else if (
      isPublishablePackage(manifest) === false &&
      validatioUtils.isObject(manifest.users)
    ) {
      // if user request to apply a star to the manifest
      stream = await this.star(manifest, {
        ...options,
      });
    } else {
      // the last option is publishing a package
      stream = await this.publish(manifest, {
        ...options,
      });
    }

    return stream;
  }

  protected async deprecate(body: Manifest, options: PublishOptions): Promise<Writable> {
    // // const storage: IPackageStorage = this.getPrivatePackageStorage(opname);

    // if (typeof storage === 'undefined') {
    //   throw errorUtils.getNotFound();
    // }
    return new PassThrough();
  }

  protected async star(body: Manifest, options: PublishOptions): Promise<Writable> {
    // // const storage: IPackageStorage = this.getPrivatePackageStorage(opname);

    // if (typeof storage === 'undefined') {
    //   throw errorUtils.getNotFound();
    // }
    return new PassThrough();
  }

  protected async publish(body: Manifest, options: PublishOptions): Promise<Writable> {
    const { name } = options;
    debug('publishing or updating a new version for %o', name);

    // TODO: improve validation body
    const isInvalidBodyFormat = false;

    if (isInvalidBodyFormat) {
      // npm is doing something strange again
      // if this happens in normal circumstances, report it as a bug
      debug('invalid body format');
      logger.info(
        { packageName: name },
        `wrong package format on publish a package @{packageName}`
      );
      throw errorUtils.getBadRequest(API_ERROR.UNSUPORTED_REGISTRY_CALL);
    }

    const manifest: Manifest = { ...validatioUtils.validateMetadata(body, name) };
    const { _attachments, versions } = manifest;
    // at this point document is either created or existed before
    const [firstAttachmentKey] = Object.keys(_attachments);
    // upload resources
    const buffer = Buffer.from(body._attachments[firstAttachmentKey].data as string, 'base64');

    if (buffer.length === 0) {
      throw errorUtils.getBadData('refusing to accept zero-length file');
    }

    try {
      await this.addPackageLocalPackage(name);
    } catch (err: any) {
      if (err && err.status !== HTTP_STATUS.CONFLICT) {
        debug('error on change or update a package with %o', err.message);
        throw err;
      }
    }

    const readable = Readable.from(buffer);
    const stream: Writable = await this.uploadTarball(name, firstAttachmentKey, {
      signal: options.signal,
    });

    stream.on('error', function (err) {
      debug(
        'error on stream a tarball %o for %o with error %o',
        'foo.tar.gz',
        options.name,
        err.message
      );
    });

    try {
      await pipeline(readable, stream, { signal: options.signal });
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'error @{err} on publish a package ');
      throw err;
    }

    return stream;

    // // after tarball has been successfully uploaded, we update the version
    // const versionToPublish: string = Object.keys(versions)[0];
    // // TODO: review why do this
    // versions[versionToPublish].readme =
    //   _.isNil(manifest.readme) === false ? String(manifest.readme) : '';

    // try {
    //   await this.addVersionNext(name, versionToPublish, versions[versionToPublish], null);
    // } catch (err: any) {
    //   debug('error on create a version for %o with error %o', name, err.message);
    //   // TODO: remove tarball if add version fails
    //   throw err;
    // }
  }

  /**
   * Add a new version to a package
   * @param name package name
   * @param version version
   * @param metadata version metadata
   * @param tag tag of the version
   */
  public async addVersionNext(
    name: string,
    version: string,
    metadata: Version,
    tag: StringValue
  ): Promise<void> {
    debug(`add version %s package for %s`, version, name);
    await this.updatePackageNext(name, async (data: Manifest): Promise<Manifest> => {
      debug('%s package is being updated', name);
      // keep only one readme per package
      data.readme = metadata.readme;
      debug('%s` readme mutated', name);
      // TODO: lodash remove
      metadata = cleanUpReadme(metadata);
      metadata.contributors = normalizeContributors(metadata.contributors as Author[]);
      debug('%s` contributors normalized', name);
      const hasVersion = data.versions[version] != null;
      if (hasVersion) {
        debug('%s version %s already exists', name, version);
        throw errorUtils.getConflict();
      }

      // if uploaded tarball has a different shasum, it's very likely that we
      // have some kind of error
      if (validatioUtils.isObject(metadata.dist) && _.isString(metadata.dist.tarball)) {
        const tarball = metadata.dist.tarball.replace(/.*\//, '');

        if (validatioUtils.isObject(data._attachments[tarball])) {
          if (
            _.isNil(data._attachments[tarball].shasum) === false &&
            _.isNil(metadata.dist.shasum) === false
          ) {
            if (data._attachments[tarball].shasum != metadata.dist.shasum) {
              const errorMessage =
                `shasum error, ` +
                `${data._attachments[tarball].shasum} != ${metadata.dist.shasum}`;
              throw errorUtils.getBadRequest(errorMessage);
            }
          }

          const currentDate = new Date().toISOString();

          // some old storage do not have this field #740
          if (_.isNil(data.time)) {
            data.time = {};
          }

          data.time['modified'] = currentDate;

          if ('created' in data.time === false) {
            data.time.created = currentDate;
          }

          data.time[version] = currentDate;
          data._attachments[tarball].version = version;
        }
      }

      data.versions[version] = metadata;
      tagVersion(data, version, tag);

      try {
        debug('%s` add on database', name);
        await this.localStorage.getStoragePlugin().add(name);
      } catch (err: any) {
        throw errorUtils.getBadData(err.message);
      }
      return data;
    });
  }

  /**
   *  Add a {name} package to a system
      Function checks if package with the same name is available from uplinks.
      If it isn't, we create package locally
      Used storages: local (write) && uplinks
   */
  public async addPackageLocalPackage(name: string): Promise<void> {
    try {
      debug('add package for %o', name);
      await checkPackageLocal(name, this.localStorage);
      debug('look up remote for %o', name);

      await this.checkPackageRemote(name, this.isAllowPublishOffline());
      debug('publishing a package for %o', name);
      // create an empty package
      await this.createNewLocalCachePackage(name);
    } catch (err: any) {
      debug('error on add a package for %o with error %o', name, err);
      throw err;
    }
  }

  /**
   * Create an empty new local cache package without versions.
   * @param name name of the package
   * @returns
   */
  private async createNewLocalCachePackage(name: string): Promise<void> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);

    if (!storage) {
      debug(`storage is missing for %o package cannot be added`, name);
      throw errorUtils.getNotFound('this package cannot be added');
    }

    try {
      await storage.createPackageNext(name, generatePackageTemplate(name));
      return;
    } catch (err: any) {
      if (
        _.isNull(err) === false &&
        (err.code === STORAGE.FILE_EXIST_ERROR || err.code === HTTP_STATUS.CONFLICT)
      ) {
        debug(`error on creating a package for %o with error %o`, name, err.message);
        throw errorUtils.getConflict();
      }
      return;
    }
  }

  protected isAllowPublishOffline(): boolean {
    return (
      typeof this.config.publish !== 'undefined' &&
      _.isBoolean(this.config.publish.allow_offline) &&
      this.config.publish.allow_offline
    );
  }

  /**
   *
   * @param name package name
   * @param uplinksLook
   * @returns
   */
  private async checkPackageRemote(name: string, uplinksLook: boolean): Promise<void> {
    try {
      // we provide a null manifest, thus the manifest returned will be the remote one
      const [remoteManifest, upLinksErrors] = await this.syncUplinksMetadataNext(name, null, {
        uplinksLook,
      });

      // checking package exist already
      if (isNil(remoteManifest) === false) {
        throw errorUtils.getConflict(API_ERROR.PACKAGE_EXIST);
      }

      for (let errorItem = 0; errorItem < upLinksErrors.length; errorItem++) {
        // checking error
        // if uplink fails with a status other than 404, we report failure
        if (isNil(upLinksErrors[errorItem][0]) === false) {
          if (upLinksErrors[errorItem][0].status !== HTTP_STATUS.NOT_FOUND) {
            if (upLinksErrors) {
              return;
            }

            throw errorUtils.getServiceUnavailable(API_ERROR.UPLINK_OFFLINE_PUBLISH);
          }
        }
      }
    } catch (err: any) {
      if (err && err.status !== HTTP_STATUS.NOT_FOUND) {
        throw err;
      }
      return;
    }
  }

  private setDefaultRevision(json: Manifest): Manifest {
    // calculate revision from couch db
    if (_.isString(json._rev) === false) {
      json._rev = STORAGE.DEFAULT_REVISION;
    }

    // this is intended in debug mode we do not want modify the store revision
    if (_.isNil(this.config._debug)) {
      json._rev = generateRevision(json._rev);
    }

    return json;
  }

  private async writePackageNext(name: string, json: Package): Promise<void> {
    const storage: any = this.getPrivatePackageStorage(name);
    if (_.isNil(storage)) {
      // TODO: replace here 500 error
      throw errorUtils.getBadData();
    }
    await storage.savePackageNext(name, this.setDefaultRevision(json));
  }

  /**
   * @param {*} name package name
   * @param {*} updateHandler function(package, cb) - update function
   * @param {*} callback callback that gets invoked after it's all updated
   * @return {Function}
   */
  private async updatePackageNext(
    name: string,
    updateHandler: (manifest: Manifest) => Promise<Manifest>
  ): Promise<void> {
    const storage: IPackageStorage = this.getPrivatePackageStorage(name);

    if (!storage) {
      throw errorUtils.getNotFound();
    }

    // we update the package on the local storage
    const updatedManifest: Manifest = await storage.updatePackageNext(name, updateHandler);
    // after correctly updated write to the storage
    try {
      await this.writePackageNext(name, normalizePackage(updatedManifest));
    } catch (err: any) {
      if (err.code === resourceNotAvailable) {
        throw errorUtils.getInternalError('resource temporarily unavailable');
      } else if (err.code === noSuchFile) {
        throw errorUtils.getNotFound();
      } else {
        throw err;
      }
    }
  }

  public async uploadTarball(pkgName: string, filename: string, { signal }): Promise<PassThrough> {
    debug(`add a tarball for %o`, pkgName);
    assert(validatioUtils.validateName(filename));

    const shaOneHash = createTarballHash();
    const transformHash = new Transform({
      transform(chunk: any, encoding: string, callback: any): void {
        // measure the length for validation reasons
        shaOneHash.update(chunk);
        callback(null, chunk);
      },
    });
    const uploadStream = new PassThrough();
    const storage = this.getPrivatePackageStorage(pkgName);

    if (pkgName === PROTO_NAME) {
      process.nextTick((): void => {
        uploadStream.emit('error', errorUtils.getForbidden());
      });
      return uploadStream;
    }

    // FIXME: this condition will never met, storage is always defined
    if (!storage) {
      process.nextTick((): void => {
        uploadStream.emit('error', "can't upload this package storage is missing");
      });
      return uploadStream;
    }

    const fileDoesExist = await storage.hasFile(filename);
    if (fileDoesExist) {
      process.nextTick((): void => {
        uploadStream.emit('error', errorUtils.getConflict());
      });
    } else {
      const localStorageWriteStream = await storage.writeTarballNext(filename, { signal });

      localStorageWriteStream.on('open', async () => {
        await pipeline(uploadStream, transformHash, localStorageWriteStream, { signal });
      });

      // once the file descriptor has been closed
      localStorageWriteStream.on('close', async () => {
        try {
          // update the package metadata
          await this.updatePackageNext(pkgName, async (data: Manifest): Promise<Manifest> => {
            const newData: Manifest = { ...data };
            newData._attachments[filename] = {
              // TODO:  add integrity hash here
              shasum: shaOneHash.digest('hex'),
            };

            return newData;
          });
          uploadStream.emit('success');
        } catch (err) {
          // FUTURE: if the update package fails, remove tarball to avoid left
          // orphan tarballs
          uploadStream.emit('error', err);
        }
      });

      // something went wrong writing into the local storage
      localStorageWriteStream.on('error', async (err: any) => {
        uploadStream.emit('error', err);
      });
    }

    return uploadStream;
  }

  /**
   * Function fetches package metadata from uplinks and synchronizes it with local data
     if package is available locally, it MUST be provided in pkginfo.
     
    Using this example: 

    "jquery":
      access: $all
      publish: $authenticated
      unpublish: $authenticated
      # two uplinks setup
      proxy: ver npmjs  
      # one uplink setup
      proxy: npmjs    

    A package requires uplinks syncronization if enables the proxy section, uplinks
    can be more than one, the more are the most slow request will take, the request
    are made in serie and if 1st call fails, the secon will be triggered, otherwise
    the 1st will reply and others will be discareded. The order is important.

    Errors on upkinks are considered are, time outs, connection fails and http status 304, 
    in that case the request returns empty body and we want ask next on the list if has fresh 
    updates. 
   */
  public async syncUplinksMetadataNext(
    name: string,
    packageInfo: Manifest | null,
    options: ISyncUplinksOptions = {}
  ): Promise<[Manifest, any]> {
    let found = false;
    let syncManifest = {} as Manifest;
    const upLinks: Promise<Manifest>[] = [];
    const hasToLookIntoUplinks = _.isNil(options.uplinksLook) || options.uplinksLook;
    debug('is sync uplink enabled %o', hasToLookIntoUplinks);
    // ensure package has enough data
    if (_.isNil(packageInfo) || _.isEmpty(packageInfo)) {
      syncManifest = generatePackageTemplate(name);
    } else {
      syncManifest = { ...packageInfo };
    }

    for (const uplink in this.uplinks) {
      if (hasProxyTo(name, uplink, this.config.packages) && hasToLookIntoUplinks) {
        upLinks.push(this.mergeCacheRemoteMetadata(this.uplinks[uplink], syncManifest, options));
      }
    }

    if (upLinks.length === 0) {
      return [syncManifest, []];
    }

    const errors: any[] = [];
    // we resolve uplinks async in serie, first come first serve
    for (const uplinkRequest of upLinks) {
      try {
        syncManifest = await uplinkRequest;
        found = true;
        break;
      } catch (err: any) {
        errors.push(err);
        // enforce use next uplink on the list
        continue;
      }
    }
    if (found) {
      let updatedCacheManifest = await this.localStorage.updateVersionsNext(name, syncManifest);
      const [filteredManifest, filtersErrors] = await this.applyFilters(updatedCacheManifest);
      return [{ ...updatedCacheManifest, ...filteredManifest }, [...errors, ...filtersErrors]];
    } else {
      debug('uplinks sync failed with %o errors', errors.length);
      for (const err of errors) {
        const { code } = err;
        if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET') {
          throw errorUtils.getServiceUnavailable(err.code);
        }
        // we bubble up the 304 special error case
        if (code === HTTP_STATUS.NOT_MODIFIED) {
          throw err;
        }
      }
      throw errorUtils.getNotFound(API_ERROR.NO_PACKAGE);
    }
  }

  /**
   * Merge a manifest with a remote manifest.
   *
   * If the uplinks are not available, the local manifest is returned.
   * If the uplinks are available, the local manifest is merged with the remote one.
   *
   *
   * @param uplink uplink instance
   * @param cachedManifest the local cached manifest
   * @param options options
   * @returns Returns a promise that resolves with the merged manifest.
   */
  public async mergeCacheRemoteMetadata(
    uplink: IProxy,
    cachedManifest: Manifest,
    options: ISyncUplinksOptions
  ): Promise<Manifest> {
    // we store which uplink is updating the manifest
    const upLinkMeta = cachedManifest._uplinks[uplink.upname];
    let _cacheManifest = { ...cachedManifest };

    if (validatioUtils.isObject(upLinkMeta)) {
      const fetched = upLinkMeta.fetched;

      // we check the uplink cache is fresh
      if (fetched && Date.now() - fetched < uplink.maxage) {
        return cachedManifest;
      }
    }

    const remoteOptions = Object.assign({}, options, {
      etag: upLinkMeta?.etag,
    });

    try {
      // get the latest metadata from the uplink
      const [remoteManifest, etag] = await uplink.getRemoteMetadataNext(
        _cacheManifest.name,
        remoteOptions
      );

      try {
        _cacheManifest = validatioUtils.validateMetadata(remoteManifest, _cacheManifest.name);
      } catch (err: any) {
        this.logger.error(
          {
            err: err,
          },
          'package.json validating error @{!err?.message}\n@{err.stack}'
        );
        throw err;
      }
      // updates the _uplink metadata fields, cache, etc
      _cacheManifest = updateUpLinkMetadata(uplink.upname, _cacheManifest, etag);
      // merge time field cache and remote
      _cacheManifest = mergeUplinkTimeIntoLocalNext(_cacheManifest, remoteManifest);
      // update the _uplinks field in the cache
      _cacheManifest = updateVersionsHiddenUpLinkNext(cachedManifest, uplink);
      try {
        // merge versions from remote into the cache
        _cacheManifest = mergeVersions(_cacheManifest, remoteManifest);
        return _cacheManifest;
      } catch (err: any) {
        this.logger.error(
          {
            err: err,
          },
          'package.json mergin has failed @{!err?.message}\n@{err.stack}'
        );
        throw err;
      }
    } catch (error: any) {
      this.logger.error('merge uplinks data has failed');
      throw error;
    }
  }

  /**
   * Apply filters to manifest.
   * @param manifest
   * @returns
   */
  public async applyFilters(manifest: Manifest): Promise<[Manifest, any]> {
    if (this.filters.length === 0) {
      return [manifest, []];
    }

    let filterPluginErrors: any[] = [];
    let filteredManifest = { ...manifest };
    for (const filter of this.filters) {
      // These filters can assume it's save to modify packageJsonLocal
      // and return it directly for
      // performance (i.e. need not be pure)
      try {
        filteredManifest = await filter.filter_metadata(manifest);
      } catch (err: any) {
        this.logger.error({ err: err.message }, 'filter has failed @{err}');
        filterPluginErrors.push(err);
      }
    }
    return [filteredManifest, filterPluginErrors];
  }
}

export default AbstractStorage;
