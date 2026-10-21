// Minimal event harness; real layout/visibility is checked in the browser release audit.
export function tasteElement() {
 const children=new Map();
 const node={innerHTML:'',isConnected:true,dataset:{},textContent:'',value:'',disabled:false,hidden:false,
  querySelector(selector){if(!children.has(selector))children.set(selector,tasteElement());return children.get(selector);},
  querySelectorAll(){return [];},contains(){return true;},focus(){},addEventListener(type,fn){this['on'+type]=fn;}};
 return node;
}
export const clickDish=(element,id)=>element.querySelector('.taste-cloud').onclick({target:{closest:()=>({dataset:{dish:id}})}});
