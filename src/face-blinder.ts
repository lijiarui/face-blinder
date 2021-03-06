import * as fs      from 'fs'
import * as path    from 'path'
import * as rimraf  from 'rimraf'
import * as util    from 'util'

import {
  path as APP_ROOT,
}                   from 'app-root-path'
import {
  AlignmentCache,
  EmbeddingCache,
  FaceCache,
  Facenet,
  Face,
}                   from 'facenet'
import {
  FlashStore,
}                   from 'flash-store'

import {
  log,
}                   from './config'

export interface FaceBlinderOptions {
  workdir?   : string
  threshold? : number
}

const DEFAULT_THRESHOLD = 0.75
const DEFAULT_WORKDIR   = 'face-blinder.workdir'

export class FaceBlinder {
  private nameStore:      FlashStore<string, string>
  private facenet:        Facenet
  private faceCache:      FaceCache
  private alignmentCache: AlignmentCache
  private embeddingCache: EmbeddingCache

  private workdir   : string
  private threshold : number

  constructor(options?: FaceBlinderOptions) {
    log.verbose('FaceBlinder', 'constructor()')

    options = options || {}

    this.workdir   = options.workdir    || path.join(APP_ROOT, DEFAULT_WORKDIR)
    this.threshold = options.threshold  || DEFAULT_THRESHOLD

    this.facenet        = new Facenet()
    this.faceCache      = new FaceCache(this.workdir)
    this.alignmentCache = new AlignmentCache(this.facenet, this.faceCache, this.workdir)
    this.embeddingCache = new EmbeddingCache(this.facenet, this.workdir)
  }

  public async init(): Promise<void> {
    log.verbose('FaceBlinder', 'init()')

    if (!fs.existsSync(this.workdir)) {
      fs.mkdirSync(this.workdir)
    }

    this.nameStore = new FlashStore(path.join(this.workdir, 'name.store'))

    await this.facenet.init()
    await this.faceCache.init()
    await this.alignmentCache.init()
    await this.embeddingCache.init()
  }

  public async quit(): Promise<void> {
    log.verbose('FaceBlinder', 'quit()')
    await this.facenet.quit()
  }

  public async destroy(): Promise<void> {
    log.verbose('FaceBlinder', 'destroy()')
    let err
    try {
      await this.nameStore.destroy()
    } catch (e) {
      log.error('FaceBlinder', 'destroy() exception: %s', e)
      err = e
    }
    try {
      await util.promisify(rimraf)(this.workdir)
    } catch (e) {
      log.error('FaceBlinder', 'destroy() exception: %s', e)
      err = e
    }

    if (err) {
      throw err
    }
  }

  public async see(file: string): Promise<Face[]> {
    log.verbose('FaceBlinder', 'see(%s)', file)

    const updateEmbedding = async (face: Face): Promise<void> => {
      face.embedding = await this.embeddingCache.embedding(face)
      // console.log('see: ', face)
      await this.faceCache.put(face)
      log.silly('FaceBlinder', 'see() updateEmbedding() face(md5=%s): %s', face.md5, face.embedding)
    }

    const faceList = await this.alignmentCache.align(file)
    await Promise.all(
      faceList
      .filter(f => !f.embedding)
      .map(updateEmbedding),
    )

    return faceList
  }

  public async similar(
    face: Face,
    threshold = this.threshold,
  ): Promise<Face[]> {
    log.verbose('FaceBlinder', 'similar(%s, %s)', face, threshold)

    const faceStore = this.faceCache.store
    const faceList  = [] as Face[]

    for await (const md5 of faceStore.keys()) {
      log.silly('FaceBlinder', 'similar() iterate for md5: %s', md5)
      if (md5 === face.md5) {
        continue
      }
      const otherFace = await this.faceCache.get(md5)
      if (!otherFace) {
        log.warn('FaceBlinder', 'similar() faceCache.get(md5) return null')
        continue
      }

      log.silly('FaceBlinder', 'similar() iterate for otherFace: %s: %s',
                            otherFace.md5, otherFace.embedding)
      // console.log(otherFace)

      const dist = face.distance(otherFace)
      log.silly('FaceBlinder', 'similar() dist: %s <= %s: %s', dist, threshold, dist <= threshold)
      if (dist <= threshold) {
        faceList.push(otherFace)
        // console.log(faceList)
      }
    }

    return faceList
  }

  public async recognize(face: Face): Promise<string | null> {
    log.verbose('FaceBlinder', 'recognize(%s)', face)

    const rememberedName = await this.remember(face)
    if (rememberedName) {
      return rememberedName
    }

    const similarFaceList = await this.similar(face)

    const nameDistanceListMap = {} as {
      [name: string]: number[],
    }

    for (const similarFace of similarFaceList) {
      const name = await this.nameStore.get(similarFace.md5)
      if (!name) {
        continue
      }

      if (!(name in nameDistanceListMap)) {
        nameDistanceListMap[name] = []
      }

      const dist = face.distance(similarFace)
      nameDistanceListMap[name].push(dist)
    }

    const distance = {}
    for (const name in nameDistanceListMap) {
      // TODO: better algorithm needed at here
      const distanceList = nameDistanceListMap[name]
      distance[name] = distanceList.reduce((pre, cur) => pre + cur, 0)
      distance[name] /= distanceList.length
      distance[name] /= (Math.log(distanceList.length) + 1)
    }

    if (!Object.keys(nameDistanceListMap).length) {
      return null
    }

    const nameList = Object.keys(distance)
                                  .sort((a, b) => distance[a] - distance[b])
    return nameList[0]  // minimum distance
  }

  public async remember(face: Face, name: string) : Promise<void>
  public async remember(face: Face)               : Promise<string | null>

  public async remember(face: Face, name?: string) : Promise<void | string | null> {
    log.verbose('FaceBlinder', 'name(%s, %s)', face, name)

    if (!name) {
      const storedName = await this.nameStore.get(face.md5)
      return storedName
    }

    await this.nameStore.put(face.md5, name)
  }

  public async forget(face: Face): Promise<void> {
    await this.nameStore.del(face.md5)
  }

  public file(face: Face): string {
    log.verbose('FaceBlinder', 'file(%s)', face)

    return this.faceCache.file(face.md5)
  }

  public async face(md5: string): Promise<Face | null> {
    log.verbose('FaceBlinder', 'face(%s)', md5)

    const face = await this.faceCache.get(md5)
    return face
  }

  public async list(md5Partial: string): Promise<string[]> {
    log.verbose('FaceBlinder', 'list(%s)', md5Partial)
    const md5List = await this.faceCache.list(md5Partial)
    return md5List
  }
}

export default FaceBlinder
