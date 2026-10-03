import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest'
const fixture=vi.hoisted(()=>({clients:[] as {status:string;quit:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[]}))
vi.mock('ioredis',()=>({default:class {
  status='ready'
  quit=vi.fn(async()=>'OK')
  disconnect=vi.fn(()=>{this.status='end'})
  constructor(){fixture.clients.push(this)}
  on(){return this}
}}))
vi.mock('../server/lib/config',()=>({getConfig:()=>({redisUrl:'redis://fixture.invalid:6379'})}))
import { closeRedis,createRedisConnection,getRedis } from '../server/lib/redis'

describe('Redis connection shutdown',()=>{
  beforeEach(()=>{fixture.clients=[];vi.useFakeTimers()})
  afterEach(async()=>{await closeRedis(true);vi.useRealTimers()})
  it('disconnects reconnecting queue connections without queuing an unbounded QUIT',async()=>{
    createRedisConnection()
    const client=fixture.clients[0]!
    client.status='reconnecting'
    await closeRedis()
    expect(client.quit).not.toHaveBeenCalled()
    expect(client.disconnect).toHaveBeenCalledOnce()
  })
  it('force-disconnects every shared and queue connection immediately',async()=>{
    createRedisConnection();getRedis()
    await closeRedis(true)
    for(const client of fixture.clients){expect(client.quit).not.toHaveBeenCalled();expect(client.disconnect).toHaveBeenCalledOnce()}
  })
  it('bounds a stalled QUIT and disconnects the socket after five seconds',async()=>{
    createRedisConnection()
    const client=fixture.clients[0]!
    client.quit.mockImplementation(()=>new Promise(()=>{}))
    const closing=closeRedis()
    await vi.advanceTimersByTimeAsync(5000)
    await closing
    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('allows a healthy connection to quit gracefully and clears its timeout',async()=>{
    getRedis()
    await closeRedis()
    expect(fixture.clients[0]!.quit).toHaveBeenCalledOnce()
    expect(fixture.clients[0]!.disconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
