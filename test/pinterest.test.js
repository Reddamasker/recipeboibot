import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pin-test-')), 'test.sqlite');
process.env.TELEGRAM_POLLING = 'false';
const { pinterestPin, parsePinterestPin, extractPinterestRecipe } = await import('../src/pinterest.js');
const { db } = await import('../src/db.js');
const { downloadRecipeVideo } = await import('../src/youtube-media.js');
test.after(() => db.close());
const id = '748793875572163385', url = `https://www.pinterest.com/pin/${id}/`;
const makeHtml = pin => `<script>window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%7D", ${JSON.stringify({ data: { pin } })});</script>`;
const pin = { entityId: id, description: 'Ingredients and preparation from this pin only', images_orig: { url: 'https://i.pinimg.com/originals/test.jpg' } };

test('Pinterest URLs accept pins and short links, strip sharing data, reject boards and hostile hosts', () => {
  assert.equal(pinterestPin('https://ru.pinterest.com/pin/'+id+'/sent/?sender=private').url, url);
  assert.equal(pinterestPin('https://pin.it/6Tbynf1ND?utm_source=x').url, 'https://pin.it/6Tbynf1ND');
  assert.equal(pinterestPin('https://pinterest.com.evil.test/pin/'+id), null);
  assert.throws(() => pinterestPin('https://www.pinterest.com/board/name/'));
  assert.throws(() => pinterestPin('https://user:pass@pinterest.com/pin/'+id));
});
test('only requested pin is read; story video wins over false isVideo and cover', () => {
  const data = { ...pin, isVideo: false, storyPinData: { pages: [{ blocks: [{ videoDataV2: {} }] }] } };
  assert.equal(parsePinterestPin(makeHtml(data), id).video, true);
  assert.throws(() => parsePinterestPin(makeHtml({...pin,entityId:'12345'}),id));
  assert.throws(() => parsePinterestPin('<script>throw Error("do not execute")</script>',id));
  assert.throws(() => parsePinterestPin(makeHtml({...pin,storyPinData:{pages:[{},{}]}}),id),{code:'PINTEREST_MULTIPAGE_UNSUPPORTED'});
});
test('short-link video sends real frames and sound to normalization, never the page shell', async () => {
  const frame = {buffer:Buffer.from('frame'),mime:'image/jpeg'};
  let calls=0;
  const result = await extractPinterestRecipe('https://pin.it/6Tbynf1ND', {
    fetchText:async (input,limit,options) => {
      assert.equal(options.allowUrl(new URL('https://127.0.0.1/')),false);
      return {url, text:makeHtml({...pin,storyPinData:{pages:[{blocks:[{videoDataV2:{}}]}]}})};
    }, download:async identity => {assert.equal(identity.url,url);return {images:[frame],audio:{buffer:Buffer.from('sound')}};},
    transcribe:async () => 'Fish, salt; bake until ready.',
    normalize:async input => {calls++;assert.deepEqual(input.images,[frame]);assert.match(input.text,/Fish, salt/);assert.equal(input.image,undefined);return {title:'Fish',ingredients:[],steps:[]};}
  });
  assert.equal(calls,1); assert.equal(result.source.url,url); assert.equal(result.recipe.title,'Fish');
});
test('image pins use image recognition; unsupported media and missing recipe have actionable errors', async () => {
  const base={fetchText:async()=>({url,text:makeHtml(pin)})};
  const result=await extractPinterestRecipe(url,{...base,fetchImage:async(u,n,o)=>{
    assert.equal(o.allowUrl(new URL('https://evil.test/x.jpg')),false);
    return {contentType:'image/jpeg',buffer:Buffer.from('photo')};
  },normalize:async input=>{assert.equal(input.image.mime,'image/jpeg');return {title:'Image recipe'};}});
  assert.equal(result.recipe.title,'Image recipe');
  await assert.rejects(extractPinterestRecipe(url,{...base,fetchImage:async()=>({contentType:'text/html',buffer:Buffer.from('html')})}),{code:'PINTEREST_SOURCE_UNAVAILABLE'});
  await assert.rejects(extractPinterestRecipe(url,{...base,fetchImage:async()=>({contentType:'image/jpeg',buffer:Buffer.from('photo')}),normalize:async()=>{throw Object.assign(Error(),{code:'RECIPE_NOT_FOUND'});}}),{code:'PINTEREST_RECIPE_NOT_FOUND'});
});
test('wrong pin redirect and arbitrary downloader input cannot be processed',async()=>{
  await assert.rejects(extractPinterestRecipe(url,{fetchText:async()=>({url:'https://www.pinterest.com/pin/12345/',text:makeHtml(pin)})}),{code:'PINTEREST_SOURCE_UNAVAILABLE'});
  await assert.rejects(downloadRecipeVideo({id:'1',url:'https://127.0.0.1/'}),{code:'INVALID_MEDIA_URL'});
});

test('Pinterest downloader pins its extractor and identity and removes temporary media',async()=>{
  let dir;const fsp=await import('node:fs/promises');
  const result=await downloadRecipeVideo({id,url},{run:async(binary,args,options)=>{
    if(args.includes('--print-json')){dir=options.directory;assert.equal(args.at(-1),url);assert.equal(args[args.indexOf('--use-extractors')+1],'Pinterest');await fsp.writeFile(path.join(dir,'media.mp4'),'video');return JSON.stringify({id});}
    if(args.includes('-show_format'))return JSON.stringify({format:{duration:'57.633'},streams:[{codec_type:'video'}]});
    await fsp.writeFile(path.join(dir,'frame-01.jpg'),'frame');return '';
  }});assert.equal(result.images.length,1);assert.equal(result.audio,null);await assert.rejects(fsp.access(dir));
});
