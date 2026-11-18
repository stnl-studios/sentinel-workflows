/** Bounded independent cells. Stop prevents new work, never hides started outcomes. */
export async function runPool(cells,concurrency,execute,{admit=()=>true,onResult=()=>{}}={}){
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>3)throw Error('invalid concurrency');
 let cursor=0,stopped=false;const results=[];
 async function worker(){while(!stopped){if(cursor>=cells.length)return;const cell=cells[cursor];if(!admit(cell)){stopped=true;return;}cursor++;let result;try{result=await execute(cell);}catch(error){result={...cell,status:'HARNESS_FAILED',error:String(error.message)};}results.push(result);await onResult(result);}}
 await Promise.all(Array.from({length:Math.min(concurrency,cells.length)},worker));return{results,planned:cells.length,started:cursor,notStarted:cells.length-cursor,stopped};
}
