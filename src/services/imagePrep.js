// Normalize an image before it goes to a vision model.
//
// Why this exists: iOS photo-library assets are frequently HEIC (which the
// Claude and OpenAI vision APIs reject outright) and full-resolution phone
// photos routinely exceed the 5 MB post-base64 payload cap. Either one makes
// callPersona's vision request 400, which the chat surfaces only as a transient
// banner — so a picture to a persona just looked like it got no reply.
//
// Every attach path (library pick, camera, sampled video frames, link media)
// runs its images through prepareImage() first: downscale the long edge to
// Claude's effective maximum and re-encode as JPEG, returning the base64 inline
// so the send path never has to touch the filesystem again.
import*as ImageManipulator from 'expo-image-manipulator';
import*as FileSystem from 'expo-file-system';

const MAX_EDGE=1568;        // Claude's effective max image dimension
const JPEG_QUALITY=0.7;     // keeps a full-frame photo well under the 5 MB cap

// image: { uri?, data?, mime? } -> { data: <base64>, mime: 'image/jpeg' }
// On any failure, falls back to a raw base64 read of the original so a PNG/JPEG
// that didn't need touching still goes through; a genuinely unreadable asset
// throws so the caller can show a real error instead of silent nothing.
export async function prepareImage(image){
  if(!image)throw new Error('no image');
  const src=image.uri;
  if(src){
    try{
      const out=await ImageManipulator.manipulateAsync(
        src,
        [{resize:{width:MAX_EDGE}}],
        {compress:JPEG_QUALITY,format:ImageManipulator.SaveFormat.JPEG,base64:true},
      );
      if(out?.base64)return{data:out.base64,mime:'image/jpeg'};
    }catch(e){
      // Manipulator can't read some exotic formats — fall through to a raw read.
    }
    const data=await FileSystem.readAsStringAsync(src,{encoding:FileSystem.EncodingType.Base64});
    return{data,mime:image.mime||'image/jpeg'};
  }
  if(image.data)return{data:image.data,mime:image.mime||'image/jpeg'};
  throw new Error('image has neither uri nor data');
}

// Prepare a list of {type:'image', uri|data} attachment blocks in place.
// Blocks that fail to prepare are dropped; the returned array may be shorter.
export async function prepareImageBlocks(blocks){
  const out=[];
  for(const b of blocks||[]){
    if(!b||b.type!=='image'){out.push(b);continue;}
    try{
      const{data,mime}=await prepareImage(b);
      out.push({...b,uri:undefined,data,mime});
    }catch{/* unreadable — drop it */}
  }
  return out;
}
