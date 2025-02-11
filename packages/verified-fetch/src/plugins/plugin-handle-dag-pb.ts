import { code as dagPbCode } from '@ipld/dag-pb'
import { exporter } from 'ipfs-unixfs-exporter'
import { CustomProgressEvent } from 'progress-events'
import { ByteRangeContext } from '../utils/byte-range-context.js'
import { getStreamFromAsyncIterable } from '../utils/get-stream-from-async-iterable.js'
import { setIpfsRoots } from '../utils/response-headers.js'
import { badGatewayResponse, badRangeResponse, movedPermanentlyResponse, notSupportedResponse, okRangeResponse } from '../utils/responses.js'
import { setContentType } from '../utils/set-content-type.js'
import { BasePlugin } from './plugin-base.js'
import type { PluginContext } from './types.js'
import type { CIDDetail } from '../index.js'

/**
 * Handles UnixFS and dag-pb content.
 */
export class DagPbPlugin extends BasePlugin {
  readonly codes = [dagPbCode]
  canHandle ({ cid, accept, pathDetails }: PluginContext): boolean {
    this.log('checking if we can handle %c with accept %s', cid, accept)
    if (pathDetails == null) {
      return false
    }

    return cid.code === dagPbCode
  }

  /**
   * @see https://specs.ipfs.tech/http-gateways/path-gateway/#use-in-directory-url-normalization
   */
  getRedirectUrl (context: PluginContext): string | null {
    const { resource, path } = context
    const redirectCheckNeeded = path === '' ? !resource.toString().endsWith('/') : !path.endsWith('/')
    if (redirectCheckNeeded) {
      try {
        const url = new URL(resource.toString())
        // make sure we append slash to end of the path
        url.pathname = `${url.pathname}/`
        return url.toString()
      } catch (err: any) {
        // resource is likely a CID
        return `${resource.toString()}/`
      }
    }
    return null
  }

  async handle (context: PluginContext): Promise<Response> {
    const { cid, options, withServerTiming = false, pathDetails } = context
    const { handleServerTiming, contentTypeParser, helia } = this.pluginOptions
    const log = this.log
    let resource = context.resource
    let path = context.path

    let redirected = false
    const byteRangeContext = new ByteRangeContext(this.pluginOptions.logger, options?.headers)

    if (pathDetails == null) {
      throw new TypeError('Path details are required')
    }
    const ipfsRoots = pathDetails.ipfsRoots
    const terminalElement = pathDetails.terminalElement
    let resolvedCID = terminalElement.cid

    if (terminalElement?.type === 'directory') {
      const dirCid = terminalElement.cid
      const redirectUrl = this.getRedirectUrl(context)

      if (redirectUrl != null) {
        log.trace('directory url normalization spec requires redirect...')
        if (options?.redirect === 'error') {
          log('could not redirect to %s as redirect option was set to "error"', redirectUrl)
          throw new TypeError('Failed to fetch')
        } else if (options?.redirect === 'manual') {
          log('returning 301 permanent redirect to %s', redirectUrl)
          return movedPermanentlyResponse(resource, redirectUrl)
        }
        log('following redirect to %s', redirectUrl)

        // fall-through simulates following the redirect?
        resource = redirectUrl
        redirected = true
      }

      const rootFilePath = 'index.html'
      try {
        log.trace('found directory at %c/%s, looking for index.html', cid, path)

        const entry = await handleServerTiming('exporter-dir', '', async () => exporter(`/ipfs/${dirCid}/${rootFilePath}`, helia.blockstore, {
          signal: options?.signal,
          onProgress: options?.onProgress
        }), withServerTiming)

        log.trace('found root file at %c/%s with cid %c', dirCid, rootFilePath, entry.cid)
        path = rootFilePath
        resolvedCID = entry.cid
      } catch (err: any) {
        options?.signal?.throwIfAborted()
        log('error loading path %c/%s', dirCid, rootFilePath, err)
        return notSupportedResponse('Unable to find index.html for directory at given path. Support for directories with implicit root is not implemented')
      } finally {
        options?.onProgress?.(new CustomProgressEvent<CIDDetail>('verified-fetch:request:end', { cid: dirCid, path: rootFilePath }))
      }
    }

    // we have a validRangeRequest & terminalElement is a file, we know the size and should set it
    if (byteRangeContext.isRangeRequest && byteRangeContext.isValidRangeRequest && terminalElement.type === 'file') {
      byteRangeContext.setFileSize(terminalElement.unixfs.fileSize())

      log.trace('fileSize for rangeRequest %d', byteRangeContext.getFileSize())
    }
    const offset = byteRangeContext.offset
    const length = byteRangeContext.length
    log.trace('calling exporter for %c/%s with offset=%o & length=%o', resolvedCID, path, offset, length)

    try {
      const entry = await handleServerTiming('exporter-file', '', async () => exporter(resolvedCID, helia.blockstore, {
        signal: options?.signal,
        onProgress: options?.onProgress
      }), withServerTiming)

      const asyncIter = entry.content({
        signal: options?.signal,
        onProgress: options?.onProgress,
        offset,
        length
      })
      log('got async iterator for %c/%s', cid, path)

      const { stream, firstChunk } = await handleServerTiming('stream-and-chunk', '', async () => getStreamFromAsyncIterable(asyncIter, path ?? '', this.pluginOptions.logger, {
        onProgress: options?.onProgress,
        signal: options?.signal
      }), withServerTiming)

      byteRangeContext.setBody(stream)
      // if not a valid range request, okRangeRequest will call okResponse
      const response = okRangeResponse(resource, byteRangeContext.getBody(), { byteRangeContext, log }, {
        redirected
      })

      await handleServerTiming('set-content-type', '', async () => setContentType({ bytes: firstChunk, path, response, contentTypeParser, log }), withServerTiming)

      setIpfsRoots(response, ipfsRoots)

      return response
    } catch (err: any) {
      options?.signal?.throwIfAborted()
      log.error('error streaming %c/%s', cid, path, err)
      if (byteRangeContext.isRangeRequest && err.code === 'ERR_INVALID_PARAMS') {
        return badRangeResponse(resource)
      }
      return badGatewayResponse(resource.toString(), 'Unable to stream content')
    }
  }
}
