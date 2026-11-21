/** FIFO, bounded independent cells. Close the queue on a control error and drain launched cells. */
export async function runPool(cells,concurrency,execute,{admit=()=>true,onStart=()=>{},onResult=()=>{},isFatal=()=>false}={}){
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>3)throw Error('invalid concurrency');
 let cursor=0,stopped=false,controlError,fatalError;const results=[];
 async function worker(slot){try{
  while(!stopped&&cursor<cells.length){
   const queueIndex=cursor,cell=cells[queueIndex];
   if(!admit(cell)){stopped=true;return;}
   cursor++;
   const dispatch={slot,queueIndex};
   onStart(cell,dispatch);
   let result;
   try{result=await execute(cell,dispatch);}catch(error){result={...cell,status:'HARNESS_FAILED',error:String(error.message)};if(isFatal(error)){stopped=true;fatalError??=error;}}
   results.push(result);
   await onResult(result,dispatch);
  }
 }catch(error){stopped=true;controlError??=error;}}
 await Promise.all(Array.from({length:Math.min(concurrency,cells.length)},(_,i)=>worker(i+1)));
 if(fatalError||controlError)throw fatalError??controlError;
 return{results,planned:cells.length,started:cursor,notStarted:cells.length-cursor,stopped};
}
