"use strict";var PromoEngine=(()=>{var ge=Object.defineProperty;var St=Object.getOwnPropertyDescriptor;var kt=Object.getOwnPropertyNames;var Et=Object.prototype.hasOwnProperty;var At=(t,e)=>{for(var n in e)ge(t,n,{get:e[n],enumerable:!0})},Tt=(t,e,n,r)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of kt(e))!Et.call(t,i)&&i!==n&&ge(t,i,{get:()=>e[i],enumerable:!(r=St(e,i))||r.enumerable});return t};var $t=t=>Tt(ge({},"__esModule",{value:!0}),t);var cn={};At(cn,{AbortableRequest:()=>Q,AjaxCartAdapter:()=>R,PromoEvents:()=>v,StorefrontApiAdapter:()=>_e,debounce:()=>ee,emit:()=>I,initBundleBuilder:()=>wt,initCartDrawerIntegration:()=>yt,initFbtWidget:()=>he,initGiftSlider:()=>fe,initTodayOfferWidget:()=>vt,on:()=>E,publishAnalytics:()=>A});var He=Promise.resolve();function Pt(t){let e=t.split("/").pop()??t;if(!/^\d+$/.test(e))throw new Error("Invalid Shopify variant ID.");let n=Number(e);if(!Number.isSafeInteger(n)||n<=0)throw new Error("Invalid Shopify variant ID.");return n}function B(t){return new Promise((e,n)=>{He=He.then(t).then(e,n)})}async function F(t,e){let n=await fetch(t,{...e,headers:{"Content-Type":"application/json",Accept:"application/json",...e?.headers}});if(!n.ok){let r=await n.text();throw new Error(`Cart API error ${n.status}: ${r}`)}return n.json()}var R={async getCart(){return F(`${window.Shopify?.routes?.root??"/"}cart.js`)},async addLines(t){if(t.length===0)return this.getCart();if(t.length>250)throw new Error("Cannot add more than 250 cart lines at once.");return B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/add.js`,{method:"POST",body:JSON.stringify({items:t.map(e=>({id:Pt(e.variantId),quantity:Number.isSafeInteger(e.quantity)&&e.quantity>0?e.quantity:1,properties:e.properties}))})}))},async updateLine(t){return B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:t.quantity,...t.properties?{properties:t.properties}:{}})}))},async removeLine(t){return B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:0})}))},async removeLines(t){let e=[...new Set(t.flatMap(n=>n.key?[n.key]:[]))];return e.length===0?this.getCart():B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({updates:Object.fromEntries(e.map(n=>[n,0]))})}))},async applyDiscountCode(t){return B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:t})}))},async removeDiscountCode(){return B(()=>F(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:""})}))}};function ee(t,e){let n=null,r=null;function i(...c){r=c,n!==null&&clearTimeout(n),n=setTimeout(()=>{n=null,r&&t(...r)},e)}function o(){n!==null&&(clearTimeout(n),n=null)}function a(){o(),r&&t(...r)}return{call:i,cancel:o,flush:a}}var Q=class{controller=null;start(){return this.controller&&this.controller.abort("superseded"),this.controller=new AbortController,this.controller.signal}cancel(){this.controller&&(this.controller.abort("cancelled"),this.controller=null)}};var v={CartChanged:"promo-engine:cart-changed",EvaluationRequested:"promo-engine:evaluation-requested",EvaluationCompleted:"promo-engine:evaluation-completed",GiftAutoAdded:"promo-engine:gift-auto-added",GiftAdded:"promo-engine:gift-added",GiftUpdated:"promo-engine:gift-updated",GiftRemoved:"promo-engine:gift-removed",GiftSliderRequested:"promo-engine:gift-slider-requested",GiftSliderClosed:"promo-engine:gift-slider-closed",ProductChanged:"promo-engine:product-changed",CartMessageRender:"promo-engine:cart-message-render",ProgressRerender:"promo-engine:progress-rerender",TodayOfferRender:"promo-engine:today-offer-render",BundleInit:"promo-engine:bundle-init",UpsellInit:"promo-engine:upsell-init",CheckoutPrepare:"promo-engine:checkout-prepare",CartMutationError:"promo-engine:cart-mutation-error",InventoryFailure:"promo-engine:inventory-failure"};function I(t,e){window.dispatchEvent(new CustomEvent(t,{detail:e,bubbles:!0}))}function E(t,e,n){let r=i=>e(i.detail);return window.addEventListener(t,r,n),()=>window.removeEventListener(t,r)}function A(t,e){typeof window.Shopify?.analytics?.publish=="function"&&window.Shopify.analytics.publish(t,e)}function be(t,e,n){for(let r of t.items){if(r.variant_id!==e)continue;let i=r.properties??{};if(Object.entries(n).every(([a,c])=>i[a]===c))return r.key}return null}function ye(t,e){return t.items.find(n=>n.properties?._promo_engine_line_type==="gift"&&n.properties?._promo_engine_offer_id===e)??null}async function ve(){let t=await fetch(`${window.Shopify?.routes?.root??"/"}cart.js`,{headers:{Accept:"application/json"}});if(!t.ok)throw new Error(`Cart fetch failed: ${t.status}`);return t.json()}var de,C,Ve,Lt,z,Fe,We,Ke,xe,ne,W,Ye,Se,we,Ce,Rt,oe={},ae=[],qt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,ce=Array.isArray;function U(t,e){for(var n in e)t[n]=e[n];return t}function ke(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function D(t,e,n){var r,i,o,a={};for(o in e)o=="key"?r=e[o]:o=="ref"?i=e[o]:a[o]=e[o];if(arguments.length>2&&(a.children=arguments.length>3?de.call(arguments,2):n),typeof t=="function"&&t.defaultProps!=null)for(o in t.defaultProps)a[o]===void 0&&(a[o]=t.defaultProps[o]);return re(t,a,r,i,null)}function re(t,e,n,r,i){var o={type:t,props:e,key:n,ref:r,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:i??++Ve,__i:-1,__u:0};return i==null&&C.vnode!=null&&C.vnode(o),o}function j(t){return t.children}function ie(t,e){this.props=t,this.context=e}function V(t,e){if(e==null)return t.__?V(t.__,t.__i+1):null;for(var n;e<t.__k.length;e++)if((n=t.__k[e])!=null&&n.__e!=null)return n.__e;return typeof t.type=="function"?V(t):null}function Ot(t){if(t.__P&&t.__d){var e=t.__v,n=e.__e,r=[],i=[],o=U({},e);o.__v=e.__v+1,C.vnode&&C.vnode(o),Ee(t.__P,o,e,t.__n,t.__P.namespaceURI,32&e.__u?[n]:null,r,n??V(e),!!(32&e.__u),i),o.__v=e.__v,o.__.__k[o.__i]=o,et(r,o,i),e.__e=e.__=null,o.__e!=n&&Je(o)}}function Je(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),Je(t)}function Ge(t){(!t.__d&&(t.__d=!0)&&z.push(t)&&!se.__r++||Fe!=C.debounceRendering)&&((Fe=C.debounceRendering)||We)(se)}function se(){try{for(var t,e=1;z.length;)z.length>e&&z.sort(Ke),t=z.shift(),e=z.length,Ot(t)}finally{z.length=se.__r=0}}function Xe(t,e,n,r,i,o,a,c,u,d,p){var s,m,_,f,w,g,y,h=r&&r.__k||ae,S=e.length;for(u=jt(n,e,h,u,S),s=0;s<S;s++)(_=n.__k[s])!=null&&(m=_.__i!=-1&&h[_.__i]||oe,_.__i=s,g=Ee(t,_,m,i,o,a,c,u,d,p),f=_.__e,_.ref&&m.ref!=_.ref&&(m.ref&&Ae(m.ref,null,_),p.push(_.ref,_.__c||f,_)),w==null&&f!=null&&(w=f),(y=!!(4&_.__u))||m.__k===_.__k?(u=Ze(_,u,t,y),y&&m.__e&&(m.__e=null)):typeof _.type=="function"&&g!==void 0?u=g:f&&(u=f.nextSibling),_.__u&=-7);return n.__e=w,u}function jt(t,e,n,r,i){var o,a,c,u,d,p=n.length,s=p,m=0;for(t.__k=new Array(i),o=0;o<i;o++)(a=e[o])!=null&&typeof a!="boolean"&&typeof a!="function"?(typeof a=="string"||typeof a=="number"||typeof a=="bigint"||a.constructor==String?a=t.__k[o]=re(null,a,null,null,null):ce(a)?a=t.__k[o]=re(j,{children:a},null,null,null):a.constructor===void 0&&a.__b>0?a=t.__k[o]=re(a.type,a.props,a.key,a.ref?a.ref:null,a.__v):t.__k[o]=a,u=o+m,a.__=t,a.__b=t.__b+1,c=null,(d=a.__i=Dt(a,n,u,s))!=-1&&(s--,(c=n[d])&&(c.__u|=2)),c==null||c.__v==null?(d==-1&&(i>p?m--:i<p&&m++),typeof a.type!="function"&&(a.__u|=4)):d!=u&&(d==u-1?m--:d==u+1?m++:(d>u?m--:m++,a.__u|=4))):t.__k[o]=null;if(s)for(o=0;o<p;o++)(c=n[o])!=null&&(2&c.__u)==0&&(c.__e==r&&(r=V(c)),nt(c,c));return r}function Ze(t,e,n,r){var i,o;if(typeof t.type=="function"){for(i=t.__k,o=0;i&&o<i.length;o++)i[o]&&(i[o].__=t,e=Ze(i[o],e,n,r));return e}t.__e!=e&&(r&&(e&&t.type&&!e.parentNode&&(e=V(t)),n.insertBefore(t.__e,e||null)),e=t.__e);do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function Dt(t,e,n,r){var i,o,a,c=t.key,u=t.type,d=e[n],p=d!=null&&(2&d.__u)==0;if(d===null&&c==null||p&&c==d.key&&u==d.type)return n;if(r>(p?1:0)){for(i=n-1,o=n+1;i>=0||o<e.length;)if((d=e[a=i>=0?i--:o++])!=null&&(2&d.__u)==0&&c==d.key&&u==d.type)return a}return-1}function Be(t,e,n){e[0]=="-"?t.setProperty(e,n??""):t[e]=n==null?"":typeof n!="number"||qt.test(e)?n:n+"px"}function te(t,e,n,r,i){var o,a;e:if(e=="style")if(typeof n=="string")t.style.cssText=n;else{if(typeof r=="string"&&(t.style.cssText=r=""),r)for(e in r)n&&e in n||Be(t.style,e,"");if(n)for(e in n)r&&n[e]==r[e]||Be(t.style,e,n[e])}else if(e[0]=="o"&&e[1]=="n")o=e!=(e=e.replace(Ye,"$1")),a=e.toLowerCase(),e=a in t||e=="onFocusOut"||e=="onFocusIn"?a.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+o]=n,n?r?n[W]=r[W]:(n[W]=Se,t.addEventListener(e,o?Ce:we,o)):t.removeEventListener(e,o?Ce:we,o);else{if(i=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=n??"";break e}catch{}typeof n=="function"||(n==null||n===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&n==1?"":n))}}function Qe(t){return function(e){if(this.l){var n=this.l[e.type+t];if(e[ne]==null)e[ne]=Se++;else if(e[ne]<n[W])return;return n(C.event?C.event(e):e)}}}function Ee(t,e,n,r,i,o,a,c,u,d){var p,s,m,_,f,w,g,y,h,S,k,b,P,O,M,x=e.type;if(e.constructor!==void 0)return null;128&n.__u&&(u=!!(32&n.__u),o=[c=e.__e=n.__e]),(p=C.__b)&&p(e);e:if(typeof x=="function")try{if(y=e.props,h=x.prototype&&x.prototype.render,S=(p=x.contextType)&&r[p.__c],k=p?S?S.props.value:p.__:r,n.__c?g=(s=e.__c=n.__c).__=s.__E:(h?e.__c=s=new x(y,k):(e.__c=s=new ie(y,k),s.constructor=x,s.render=Ut),S&&S.sub(s),s.state||(s.state={}),s.__n=r,m=s.__d=!0,s.__h=[],s._sb=[]),h&&s.__s==null&&(s.__s=s.state),h&&x.getDerivedStateFromProps!=null&&(s.__s==s.state&&(s.__s=U({},s.__s)),U(s.__s,x.getDerivedStateFromProps(y,s.__s))),_=s.props,f=s.state,s.__v=e,m)h&&x.getDerivedStateFromProps==null&&s.componentWillMount!=null&&s.componentWillMount(),h&&s.componentDidMount!=null&&s.__h.push(s.componentDidMount);else{if(h&&x.getDerivedStateFromProps==null&&y!==_&&s.componentWillReceiveProps!=null&&s.componentWillReceiveProps(y,k),e.__v==n.__v||!s.__e&&s.shouldComponentUpdate!=null&&s.shouldComponentUpdate(y,s.__s,k)===!1){e.__v!=n.__v&&(s.props=y,s.state=s.__s,s.__d=!1),e.__e=n.__e,e.__k=n.__k,e.__k.some(function(T){T&&(T.__=e)}),ae.push.apply(s.__h,s._sb),s._sb=[],s.__h.length&&a.push(s);break e}s.componentWillUpdate!=null&&s.componentWillUpdate(y,s.__s,k),h&&s.componentDidUpdate!=null&&s.__h.push(function(){s.componentDidUpdate(_,f,w)})}if(s.context=k,s.props=y,s.__P=t,s.__e=!1,b=C.__r,P=0,h)s.state=s.__s,s.__d=!1,b&&b(e),p=s.render(s.props,s.state,s.context),ae.push.apply(s.__h,s._sb),s._sb=[];else do s.__d=!1,b&&b(e),p=s.render(s.props,s.state,s.context),s.state=s.__s;while(s.__d&&++P<25);s.state=s.__s,s.getChildContext!=null&&(r=U(U({},r),s.getChildContext())),h&&!m&&s.getSnapshotBeforeUpdate!=null&&(w=s.getSnapshotBeforeUpdate(_,f)),O=p!=null&&p.type===j&&p.key==null?tt(p.props.children):p,c=Xe(t,ce(O)?O:[O],e,n,r,i,o,a,c,u,d),s.base=e.__e,e.__u&=-161,s.__h.length&&a.push(s),g&&(s.__E=s.__=null)}catch(T){if(e.__v=null,u||o!=null)if(T.then){for(e.__u|=u?160:128;c&&c.nodeType==8&&c.nextSibling;)c=c.nextSibling;o[o.indexOf(c)]=null,e.__e=c}else{for(M=o.length;M--;)ke(o[M]);Ie(e)}else e.__e=n.__e,e.__k=n.__k,T.then||Ie(e);C.__e(T,e,n)}else o==null&&e.__v==n.__v?(e.__k=n.__k,e.__e=n.__e):c=e.__e=Mt(n.__e,e,n,r,i,o,a,u,d);return(p=C.diffed)&&p(e),128&e.__u?void 0:c}function Ie(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(Ie))}function et(t,e,n){for(var r=0;r<n.length;r++)Ae(n[r],n[++r],n[++r]);C.__c&&C.__c(e,t),t.some(function(i){try{t=i.__h,i.__h=[],t.some(function(o){o.call(i)})}catch(o){C.__e(o,i.__v)}})}function tt(t){return typeof t!="object"||t==null||t.__b>0?t:ce(t)?t.map(tt):t.constructor!==void 0?null:U({},t)}function Mt(t,e,n,r,i,o,a,c,u){var d,p,s,m,_,f,w,g=n.props||oe,y=e.props,h=e.type;if(h=="svg"?i="http://www.w3.org/2000/svg":h=="math"?i="http://www.w3.org/1998/Math/MathML":i||(i="http://www.w3.org/1999/xhtml"),o!=null){for(d=0;d<o.length;d++)if((_=o[d])&&"setAttribute"in _==!!h&&(h?_.localName==h:_.nodeType==3)){t=_,o[d]=null;break}}if(t==null){if(h==null)return document.createTextNode(y);t=document.createElementNS(i,h,y.is&&y),c&&(C.__m&&C.__m(e,o),c=!1),o=null}if(h==null)g===y||c&&t.data==y||(t.data=y);else{if(o=h=="textarea"&&y.defaultValue!=null?null:o&&de.call(t.childNodes),!c&&o!=null)for(g={},d=0;d<t.attributes.length;d++)g[(_=t.attributes[d]).name]=_.value;for(d in g)_=g[d],d=="dangerouslySetInnerHTML"?s=_:d=="children"||d in y||d=="value"&&"defaultValue"in y||d=="checked"&&"defaultChecked"in y||te(t,d,null,_,i);for(d in y)_=y[d],d=="children"?m=_:d=="dangerouslySetInnerHTML"?p=_:d=="value"?f=_:d=="checked"?w=_:c&&typeof _!="function"||g[d]===_||te(t,d,_,g[d],i);if(p)c||s&&(p.__html==s.__html||p.__html==t.innerHTML)||(t.innerHTML=p.__html),e.__k=[];else if(s&&(t.innerHTML=""),Xe(e.type=="template"?t.content:t,ce(m)?m:[m],e,n,r,h=="foreignObject"?"http://www.w3.org/1999/xhtml":i,o,a,o?o[0]:n.__k&&V(n,0),c,u),o!=null)for(d=o.length;d--;)ke(o[d]);c&&h!="textarea"||(d="value",h=="progress"&&f==null?t.removeAttribute("value"):f!=null&&(f!==t[d]||h=="progress"&&!f||h=="option"&&f!=g[d])&&te(t,d,f,g[d],i),d="checked",w!=null&&w!=t[d]&&te(t,d,w,g[d],i))}return t}function Ae(t,e,n){try{if(typeof t=="function"){var r=typeof t.__u=="function";r&&t.__u(),r&&e==null||(t.__u=t(e))}else t.current=e}catch(i){C.__e(i,n)}}function nt(t,e,n){var r,i;if(C.unmount&&C.unmount(t),(r=t.ref)&&(r.current&&r.current!=t.__e||Ae(r,null,e)),(r=t.__c)!=null){if(r.componentWillUnmount)try{r.componentWillUnmount()}catch(o){C.__e(o,e)}r.base=r.__P=null}if(r=t.__k)for(i=0;i<r.length;i++)r[i]&&nt(r[i],e,n||typeof t.type!="function");n||ke(t.__e),t.__c=t.__=t.__e=void 0}function Ut(t,e,n){return this.constructor(t,n)}function N(t,e,n){var r,i,o,a;e==document&&(e=document.documentElement),C.__&&C.__(t,e),i=(r=typeof n=="function")?null:n&&n.__k||e.__k,o=[],a=[],Ee(e,t=(!r&&n||e).__k=D(j,null,[t]),i||oe,oe,e.namespaceURI,!r&&n?[n]:i?null:e.firstChild?de.call(e.childNodes):null,o,!r&&n?n:i?i.__e:e.firstChild,r,a),et(o,t,a)}de=ae.slice,C={__e:function(t,e,n,r){for(var i,o,a;e=e.__;)if((i=e.__c)&&!i.__)try{if((o=i.constructor)&&o.getDerivedStateFromError!=null&&(i.setState(o.getDerivedStateFromError(t)),a=i.__d),i.componentDidCatch!=null&&(i.componentDidCatch(t,r||{}),a=i.__d),a)return i.__E=i}catch(c){t=c}throw t}},Ve=0,Lt=function(t){return t!=null&&t.constructor===void 0},ie.prototype.setState=function(t,e){var n;n=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=U({},this.state),typeof t=="function"&&(t=t(U({},n),this.props)),t&&U(n,t),t!=null&&this.__v&&(e&&this._sb.push(e),Ge(this))},ie.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Ge(this))},ie.prototype.render=j,z=[],We=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Ke=function(t,e){return t.__v.__b-e.__v.__b},se.__r=0,xe=Math.random().toString(8),ne="__d"+xe,W="__a"+xe,Ye=/(PointerCapture)$|Capture$/i,Se=0,we=Qe(!1),Ce=Qe(!0),Rt=0;var Nt=0;function l(t,e,n,r,i,o){e||(e={});var a,c,u=e;if("ref"in u)for(c in u={},e)c=="ref"?a=e[c]:u[c]=e[c];var d={type:t,props:u,key:n,ref:a,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--Nt,__i:-1,__u:0,__source:i,__self:o};if(typeof t=="function"&&(a=t.defaultProps))for(c in a)u[c]===void 0&&(u[c]=a[c]);return C.vnode&&C.vnode(d),d}var K,$,Te,rt,pe=0,pt=[],L=C,it=L.__b,ot=L.__r,at=L.diffed,st=L.__c,dt=L.unmount,ct=L.__;function Pe(t,e){L.__h&&L.__h($,t,pe||e),pe=0;var n=$.__H||($.__H={__:[],__h:[]});return t>=n.__.length&&n.__.push({}),n.__[t]}function q(t){return pe=1,zt(ft,t)}function zt(t,e,n){var r=Pe(K++,2);if(r.t=t,!r.__c&&(r.__=[n?n(e):ft(void 0,e),function(c){var u=r.__N?r.__N[0]:r.__[0],d=r.t(u,c);u!==d&&(r.__N=[d,r.__[1]],r.__c.setState({}))}],r.__c=$,!$.__f)){var i=function(c,u,d){if(!r.__c.__H)return!0;var p=r.__c.__H.__.filter(function(m){return m.__c});if(p.every(function(m){return!m.__N}))return!o||o.call(this,c,u,d);var s=r.__c.props!==c;return p.some(function(m){if(m.__N){var _=m.__[0];m.__=m.__N,m.__N=void 0,_!==m.__[0]&&(s=!0)}}),o&&o.call(this,c,u,d)||s};$.__f=!0;var o=$.shouldComponentUpdate,a=$.componentWillUpdate;$.componentWillUpdate=function(c,u,d){if(this.__e){var p=o;o=void 0,i(c,u,d),o=p}a&&a.call(this,c,u,d)},$.shouldComponentUpdate=i}return r.__N||r.__}function ue(t,e){var n=Pe(K++,3);!L.__s&&ut(n.__H,e)&&(n.__=t,n.u=e,$.__H.__h.push(n))}function Y(t){return pe=5,Le(function(){return{current:t}},[])}function Le(t,e){var n=Pe(K++,7);return ut(n.__H,e)&&(n.__=t(),n.__H=e,n.__h=t),n.__}function Ht(){for(var t;t=pt.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(le),e.__h.some($e),e.__h=[]}catch(n){e.__h=[],L.__e(n,t.__v)}}}L.__b=function(t){$=null,it&&it(t)},L.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),ct&&ct(t,e)},L.__r=function(t){ot&&ot(t),K=0;var e=($=t.__c).__H;e&&(Te===$?(e.__h=[],$.__h=[],e.__.some(function(n){n.__N&&(n.__=n.__N),n.u=n.__N=void 0})):(e.__h.some(le),e.__h.some($e),e.__h=[],K=0)),Te=$},L.diffed=function(t){at&&at(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(pt.push(e)!==1&&rt===L.requestAnimationFrame||((rt=L.requestAnimationFrame)||Ft)(Ht)),e.__H.__.some(function(n){n.u&&(n.__H=n.u),n.u=void 0})),Te=$=null},L.__c=function(t,e){e.some(function(n){try{n.__h.some(le),n.__h=n.__h.filter(function(r){return!r.__||$e(r)})}catch(r){e.some(function(i){i.__h&&(i.__h=[])}),e=[],L.__e(r,n.__v)}}),st&&st(t,e)},L.unmount=function(t){dt&&dt(t);var e,n=t.__c;n&&n.__H&&(n.__H.__.some(function(r){try{le(r)}catch(i){e=i}}),n.__H=void 0,e&&L.__e(e,n.__v))};var lt=typeof requestAnimationFrame=="function";function Ft(t){var e,n=function(){clearTimeout(r),lt&&cancelAnimationFrame(e),setTimeout(t)},r=setTimeout(n,35);lt&&(e=requestAnimationFrame(n))}function le(t){var e=$,n=t.__c;typeof n=="function"&&(t.__c=void 0,n()),$=e}function $e(t){var e=$;t.__c=t.__(),$=e}function ut(t,e){return!t||t.length!==e.length||e.some(function(n,r){return n!==t[r]})}function ft(t,e){return typeof e=="function"?e(t):e}var Gt=`
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4); border: 0; padding: 0;
  margin: 0; width: 100%; max-width: none; height: 100%; max-height: none;
  z-index: 9999; display: flex; align-items: flex-end; justify-content: center;
}
@media (min-width: 768px) {
  .pe-slider-overlay { align-items: center; }
}
.pe-slider-modal {
  background: #fff; border-radius: 12px 12px 0 0; width: 100%; max-width: 540px;
  max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 -4px 24px rgba(0,0,0,.15);
}
@media (min-width: 768px) {
  .pe-slider-modal { border-radius: 12px; max-height: 640px; }
}
.pe-slider-header {
  padding: 20px 20px 12px; border-bottom: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: flex-start;
}
.pe-slider-title { font-size: 18px; font-weight: 700; margin: 0; }
.pe-slider-subtitle { font-size: 13px; color: #6b7280; margin: 4px 0 0; }
.pe-slider-close {
  background: none; border: none; font-size: 20px; cursor: pointer;
  color: #6b7280; padding: 0; line-height: 1; min-width: 48px; min-height: 48px;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
  background: #fff; color: inherit; text-align: left; width: 100%; font: inherit;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
.pe-gift-card:focus-visible, .pe-slider-close:focus-visible, .pe-btn-confirm:focus-visible {
  outline: 3px solid #2563eb; outline-offset: 2px;
}
.pe-gift-card.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-gift-card.pe-unavailable { opacity: .5; cursor: not-allowed; }
.pe-gift-check {
  position: absolute; top: 8px; right: 8px; width: 20px; height: 20px;
  background: #111; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; color: #fff; font-size: 12px;
}
.pe-gift-img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 4px; background: #f3f4f6; }
.pe-gift-img-placeholder { width: 100%; aspect-ratio: 1; background: #f3f4f6; border-radius: 4px; }
.pe-gift-name { font-size: 13px; font-weight: 600; margin: 8px 0 2px; line-height: 1.3; }
.pe-gift-variant { font-size: 11px; color: #6b7280; margin: 0; }
.pe-gift-price { font-size: 12px; color: #6b7280; margin: 4px 0 0; }
.pe-gift-price s { opacity: .6; }
.pe-gift-free { color: #059669; font-weight: 700; }
.pe-gift-unavailable { color: #b42318; font-size: 11px; margin: 4px 0 0; }
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; min-height: 48px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-slider-error { color: #b42318; font-size: 13px; margin: 0 20px 12px; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
.pe-sr-only {
  position: absolute; clip-path: inset(50%); overflow: hidden;
  width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .pe-gift-card, .pe-btn-confirm { transition: none; }
  .pe-spinner { animation: none; opacity: .65; }
}
`;function Bt(){if(document.getElementById("pe-slider-styles"))return;let t=document.createElement("style");t.id="pe-slider-styles",t.textContent=Gt,document.head.appendChild(t)}function ht(t,e){try{return new Intl.NumberFormat(navigator.language||"en-US",{style:"currency",currency:e}).format(t/100)}catch{return`${(t/100).toFixed(2)} ${e}`}}function H(t){return`${t.rewardId}:${t.variantId}`}function Qt({payload:t,sessionId:e,onClose:n,onConfirm:r}){let[i,o]=q(new Set(t.selectableGifts.filter(h=>h.isSelected).map(H))),[a,c]=q(!1),[u,d]=q(null),p=Y(null),s=Y(null),m=Y(!1),_=Y(i.size),f=t.maxSelectableCount;function w(h){let S=H(h),k=new Set(i);if(k.has(S))k.delete(S);else{if(!h.isAvailable)return;let b=t.selectableGifts.filter(P=>P.rewardId===h.rewardId&&k.has(H(P))).length;if(k.size>=f||b>=h.rewardMaxQuantity)return;k.add(S)}d(null),o(k)}async function g(){if(!m.current){m.current=!0,c(!0),d(null);try{let h=t.selectableGifts.filter(S=>i.has(H(S)));await r(h),A("promo_engine:gift_selected",{offer_id:t.offerId,variant_ids:h.map(S=>S.variantId),session_id:e}),n()}catch(h){d(h instanceof Error?h.message:"We couldn't update your gifts. Please try again.")}finally{m.current=!1,c(!1)}}}function y(h){!a&&h.target===h.currentTarget&&n()}return ue(()=>{let h=document.activeElement instanceof HTMLElement?document.activeElement:null;return p.current&&!p.current.open&&p.current.showModal(),s.current?.focus(),()=>{p.current?.open&&p.current.close(),h?.focus()}},[n]),l("dialog",{ref:p,class:"pe-slider-overlay","aria-labelledby":"pe-slider-title","aria-describedby":t.subtitle?"pe-slider-subtitle":void 0,onClick:y,onCancel:h=>{h.preventDefault(),a||n()},"aria-busy":a,children:l("div",{class:"pe-slider-modal",children:[l("div",{class:"pe-slider-header",children:[l("div",{children:[l("h2",{class:"pe-slider-title",id:"pe-slider-title",children:t.title}),t.subtitle&&l("p",{class:"pe-slider-subtitle",id:"pe-slider-subtitle",children:t.subtitle})]}),l("button",{ref:s,type:"button",class:"pe-slider-close",onClick:n,disabled:a,"aria-label":"Close gift selection",children:"\u2715"})]}),l("div",{class:"pe-slider-body",children:l("div",{class:"pe-gift-grid",children:t.selectableGifts.map(h=>{let S=H(h),k=i.has(S),b=!h.isAvailable;return l("button",{type:"button",class:`pe-gift-card${k?" pe-selected":""}${b?" pe-unavailable":""}`,onClick:()=>w(h),"aria-pressed":k,disabled:b&&!k,children:[k&&l("span",{class:"pe-gift-check","aria-hidden":"true",children:"\u2713"}),h.imageUrl?l("img",{class:"pe-gift-img",src:h.imageUrl,alt:h.title,loading:"lazy",width:160,height:160}):l("div",{class:"pe-gift-img-placeholder","aria-hidden":"true"}),l("p",{class:"pe-gift-name",children:h.title}),h.variantTitle&&l("p",{class:"pe-gift-variant",children:h.variantTitle}),l("p",{class:"pe-gift-price",children:h.discountedPriceCents===0?l("span",{class:"pe-gift-free",children:"Free"}):l(j,{children:[l("s",{children:ht(h.originalPriceCents,t.currencyCode)})," ",l("span",{class:"pe-gift-free",children:ht(h.discountedPriceCents,t.currencyCode)})]})}),b&&l("p",{class:"pe-gift-unavailable",children:"Out of stock"})]},S)})})}),u&&l("p",{class:"pe-slider-error",role:"alert","aria-live":"assertive",children:u}),l("div",{class:"pe-slider-footer",children:[l("p",{class:"pe-selected-count","aria-live":"polite",children:[i.size," / ",f," selected"]}),l("button",{class:"pe-btn-confirm",type:"button",onClick:g,disabled:i.size===0&&_.current===0||a,"aria-label":a?"Updating gifts":void 0,children:a?l(j,{children:[l("span",{class:"pe-spinner",style:{display:"inline-block"},"aria-hidden":"true"}),l("span",{class:"pe-sr-only",children:"Updating gifts"})]}):i.size===0?"Remove Gifts from Cart":`Add ${i.size>0?i.size:""} Gift${i.size!==1?"s":""} to Cart`})]})]})})}var G=null;function Re(t,e){Bt(),G||(G=document.createElement("div"),G.id="pe-gift-slider-root",document.body.appendChild(G)),N(D(Qt,{payload:t,sessionId:e,onClose:()=>{G&&(N(D(j,null),G),I(v.GiftSliderClosed),A("promo_engine:gift_slider_closed",{offer_id:t.offerId,session_id:e}))},onConfirm:async i=>{let o=await window.PromoEngine?.validateGiftOffer(t.offerId);if(!o)throw new Error("This gift offer is no longer available. Your cart was not changed.");let a=new Map(o.selectableGifts.map(f=>[H(f),f])),c=i.map(f=>a.get(H(f)));if(c.some(f=>!f?.isAvailable))throw new Error("One of the selected gifts is no longer available. Please choose again.");let u=new Map;for(let f of c){if(!f)continue;let w=(u.get(f.rewardId)??0)+1;if(w>f.rewardMaxQuantity)throw new Error("Too many gifts were selected for this reward.");u.set(f.rewardId,w)}if(c.length>o.maxSelectableCount)throw new Error("Too many gifts were selected for this offer.");let p=(await R.getCart()).items.filter(f=>f.properties?._promo_engine_offer_id===t.offerId),s=new Set(c.flatMap(f=>f?[H(f)]:[])),m=p.filter(f=>{let w=f.properties??{},g=`${w._promo_engine_reward_id??""}:gid://shopify/ProductVariant/${f.variant_id}`,y=w._promo_engine_offer_version===String(o.selectableGifts[0]?.offerVersion??"");return!s.has(g)||!y}),_=c.flatMap(f=>{if(!f)return[];let w=f.variantId.split("/").pop()??f.variantId;return p.some(y=>String(y.variant_id)===w&&y.properties?._promo_engine_reward_id===f.rewardId&&y.properties?._promo_engine_offer_version===String(f.offerVersion))?[]:[{variantId:f.variantId,quantity:1,properties:{_promo_engine_line_type:"gift",_promo_engine_offer_id:t.offerId,_promo_engine_reward_id:f.rewardId,_promo_engine_offer_version:String(f.offerVersion)}}]});_.length>0&&await R.addLines(_),m.length>0&&await R.removeLines(m.map(f=>({key:f.key}))),I(v.CartChanged)}}),G),A("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e})}function fe(t){let e=new Map,n=new Set,r=null;E(v.EvaluationCompleted,i=>{e.clear(),r=null,i.giftSlider&&Array.isArray(i.giftSlider.selectableGifts)&&(r=i.giftSlider,e.set(i.giftSlider.offerId,i.giftSlider));let o=i.giftSlider?`${i.giftSlider.offerId}:${i.cartHash}:${i.giftSlider.selectableGifts.map(a=>a.offerVersion).join(",")}`:null;i.giftSlider&&Array.isArray(i.giftSlider.selectableGifts)&&i.giftSlider.alreadySelectedCount===0&&i.giftSlider.selectableGifts.some(a=>a.isAvailable)&&o&&!n.has(o)&&(n.add(o),Re(i.giftSlider,t))}),E(v.GiftSliderRequested,i=>{(async()=>{let o="selectableGifts"in i?i:null,a=o??(i.offerId?e.get(i.offerId):r)??r;if(!a)return;if(o||!window.PromoEngine?.validateGiftOffer){Re(a,t);return}let c=await window.PromoEngine.validateGiftOffer(a.offerId);c&&(r=c,e.set(c.offerId,c),Re(c,t))})()}),document.addEventListener("click",i=>{let o=i.target instanceof Element?i.target.closest("[data-promo-gift-slider-trigger]"):null;o&&I(v.GiftSliderRequested,{offerId:o.dataset.offerId||void 0})})}var Vt=`
.pe-fbt { font-family: inherit; margin: 24px 0; }
.pe-fbt-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.pe-fbt-products {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
}
.pe-fbt-product {
  display: flex; align-items: center; gap: 8px;
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 10px;
  cursor: pointer; transition: border-color .15s; min-width: 140px;
}
.pe-fbt-product.pe-selected { border-color: #111; background: #f9f9f9; }
.pe-fbt-product:hover { border-color: #9ca3af; }
.pe-fbt-check { width: 18px; height: 18px; flex-shrink: 0; }
.pe-fbt-img { width: 52px; height: 52px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-img-ph { width: 52px; height: 52px; background: #f3f4f6; border-radius: 4px; flex-shrink: 0; }
.pe-fbt-info { min-width: 0; }
.pe-fbt-name { font-size: 12px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }
.pe-fbt-price { font-size: 12px; color: #6b7280; }
.pe-fbt-price-disc { color: #059669; font-weight: 700; }
.pe-fbt-plus { font-size: 20px; color: #9ca3af; flex-shrink: 0; }
.pe-fbt-summary {
  margin-top: 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
}
.pe-fbt-total { font-size: 15px; }
.pe-fbt-total strong { font-size: 18px; }
.pe-fbt-btn {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer;
  transition: background .15s;
}
.pe-fbt-btn:hover { background: #333; }
.pe-fbt-btn:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-fbt-added { color: #059669; font-weight: 600; font-size: 14px; }
`;function J(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function Wt({config:t,currency:e,sessionId:n}){let[r,i]=q(new Set([t.mainProduct.variantId,...t.relatedProducts.slice(0,2).map(g=>g.variantId)])),[o,a]=q(!1),[c,u]=q(!1),d=[t.mainProduct,...t.relatedProducts.slice(0,t.maxProducts-1)],p=d.filter(g=>r.has(g.variantId)),s=p.reduce((g,y)=>g+y.discountedPriceCents,0),_=p.reduce((g,y)=>g+y.priceCents,0)-s;function f(g){if(g===t.mainProduct.variantId)return;let y=new Set(r);y.has(g)?y.delete(g):y.add(g),i(y)}async function w(){if(!(o||p.length===0)){a(!0);try{await R.addLines(p.map(g=>({variantId:g.variantId,quantity:1,properties:{_promo_engine_line_type:"upsell",_promo_engine_offer_id:t.offerId}}))),u(!0),I(v.CartChanged),A("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,widget_type:"fbt",variant_ids:[...r],session_id:n})}finally{a(!1)}}}return ue(()=>{A("promo_engine:widget_viewed",{offer_id:t.offerId,widget_type:"fbt",session_id:n})},[]),c?l("div",{class:"pe-fbt",children:l("p",{class:"pe-fbt-added",children:["\u2713 Added ",p.length," item(s) to cart!"]})}):l("div",{class:"pe-fbt",children:[l("h3",{class:"pe-fbt-title",children:t.title||"Frequently Bought Together"}),l("div",{class:"pe-fbt-products",children:d.map((g,y)=>{let h=r.has(g.variantId),S=g.variantId===t.mainProduct.variantId;return l(j,{children:[y>0&&l("span",{class:"pe-fbt-plus","aria-hidden":"true",children:"+"}),l("div",{class:`pe-fbt-product${h?" pe-selected":""}`,onClick:()=>f(g.variantId),role:"checkbox","aria-checked":h,tabIndex:S?-1:0,onKeyDown:k=>{(k.key===" "||k.key==="Enter")&&(k.preventDefault(),f(g.variantId))},children:[l("input",{type:"checkbox",class:"pe-fbt-check",checked:h,disabled:S,"aria-hidden":"true",tabIndex:-1,readOnly:!0}),g.imageUrl?l("img",{class:"pe-fbt-img",src:g.imageUrl,alt:g.title,loading:"lazy"}):l("div",{class:"pe-fbt-img-ph","aria-hidden":"true"}),l("div",{class:"pe-fbt-info",children:[l("p",{class:"pe-fbt-name",children:g.title}),g.variantTitle&&l("p",{class:"pe-fbt-price",children:g.variantTitle}),l("p",{class:"pe-fbt-price",children:g.discountedPriceCents<g.priceCents?l("span",{class:"pe-fbt-price-disc",children:J(g.discountedPriceCents,e)}):J(g.priceCents,e)})]})]},g.variantId)]})})}),l("div",{class:"pe-fbt-summary",children:[l("p",{class:"pe-fbt-total",children:["Total: ",l("strong",{children:J(s,e)}),_>0&&l(j,{children:[" ",l("span",{class:"pe-fbt-price-disc",children:["(save ",J(_,e),")"]})]})]}),l("button",{class:"pe-fbt-btn",onClick:w,disabled:o||p.length===0,"aria-label":`Add ${p.length} item(s) to cart for ${J(s,e)}`,children:o?"Adding\u2026":t.buttonText||`Add ${p.length} to Cart`})]})]})}function he(t,e,n,r){if(!document.getElementById("pe-fbt-styles")){let i=document.createElement("style");i.id="pe-fbt-styles",i.textContent=Vt,document.head.appendChild(i)}N(D(Wt,{config:e,currency:n,sessionId:r}),t)}var Kt=300,Yt="/apps/promo-engine/evaluate",_t="promo_engine_session_id";function mt(){return typeof crypto.randomUUID=="function"?crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,t=>{let e=Math.random()*16|0;return(t==="x"?e:e&3|8).toString(16)})}function bt(){try{let t=sessionStorage.getItem(_t);return t||(t=mt(),sessionStorage.setItem(_t,t)),t}catch{return mt()}}var qe=class{config;sessionId;evaluationAbort=new Q;debouncedEvaluate;lastCartHash=null;savedFetch=window.fetch.bind(window);refreshGuard=!1;capturedThemeSectionIds=[];lastEvaluationResult=null;constructor(e){this.config=e,this.sessionId=bt(),this.debouncedEvaluate=ee(()=>this.triggerEvaluation(),Kt)}init(){this.log("Promo Engine initialized",this.config),this.detectTheme(),this.listenForCartChanges(),this.triggerEvaluation()}detectTheme(){let e=window.Shopify,n=e?.theme?.schema_name??e?.theme?.name??"unknown";this.log(`[PromoEngine] Theme detected: ${n}`),!!document.querySelector("cart-drawer")&&this.log("[PromoEngine] Cart component: cart-drawer web component (Dawn-style)")}listenForCartChanges(){this.patchFetch(),document.addEventListener("cart:updated",()=>this.debouncedEvaluate.call()),document.addEventListener("cart:refresh",()=>this.debouncedEvaluate.call()),document.addEventListener("theme:cart:open",()=>this.debouncedEvaluate.call()),E(v.CartChanged,()=>this.debouncedEvaluate.call())}patchFetch(){let e=/\/cart\/(add|change|update)(\.js)?(\?|$)/,n=/\/cart(\.js|\/(add|change|update)(\.js)?)?(\?|$)/;this.savedFetch=window.fetch.bind(window);let r=this.savedFetch;window.fetch=async(i,o)=>{let a=typeof i=="string"?i:i instanceof URL?i.href:i.url,u=(o?.method??"GET").toUpperCase()==="POST"&&e.test(a),d=n.test(a),p=await r(i,o);return p.ok&&d&&(p.clone().json().then(m=>{if(!this.refreshGuard&&m!==null&&typeof m=="object"&&"sections"in m){let _=m.sections??{},f=Object.keys(_).filter(w=>typeof _[w]=="string"&&_[w].length>0);f.length>0&&(this.capturedThemeSectionIds=f,this.log("Theme section IDs captured:",f.join(", ")))}}).catch(()=>{}),u&&!this.refreshGuard&&(this.log(`[PromoEngine] Cart mutation detected (${a}) \u2014 scheduling evaluation`),this.debouncedEvaluate.call())),p}}async refreshCartUI(){let e=document.querySelector("cart-drawer"),n=this.capturedThemeSectionIds.map(d=>({sectionId:d,selector:`#shopify-section-${d}`})).filter(d=>!!document.querySelector(d.selector)),r=e?.getSectionsToRender?e.getSectionsToRender().map(d=>({sectionId:d.id,selector:d.selector??`#${d.id}`})):[],i=["cart","drawer","mini"],o=[];document.querySelectorAll('[id^="shopify-section-"]').forEach(d=>{let p=d.id.replace("shopify-section-","");i.some(s=>p.toLowerCase().includes(s))&&o.push({sectionId:p,selector:`#${d.id}`})});let a=[{sectionId:"cart-drawer",selector:"#CartDrawer"},{sectionId:"cart-drawer",selector:"#shopify-section-cart-drawer"},{sectionId:"cart-icon-bubble",selector:"#cart-icon-bubble"},{sectionId:"mini-cart",selector:"#mini-cart"},{sectionId:"mini-cart",selector:'[data-section-id="mini-cart"]'},{sectionId:"cart",selector:"#shopify-section-cart"}],c=new Set,u=[...n,...r,...o,...a].filter(d=>c.has(d.selector)?!1:(c.add(d.selector),!!document.querySelector(d.selector)));if(this.log("refreshCartUI \u2014 targets:",u.length>0?u.map(d=>`${d.sectionId}\u2192${d.selector}`).join(", "):"none found"),u.length>0){let d=[...new Set(u.map(p=>p.sectionId))];try{let p=await this.savedFetch(`/cart?sections=${d.join(",")}`,{headers:{Accept:"application/json"}});if(p.ok){let s=await p.json();if(this.log("refreshCartUI \u2014 section render response keys:",Object.keys(s.sections??{}).join(", ")||"none (Shopify returned plain cart JSON \u2014 section IDs not valid for this theme)"),s.sections){let m=0;for(let{sectionId:_,selector:f}of u){let w=s.sections[_];if(!w)continue;let g=document.querySelector(f);if(!g)continue;let y=e?.getSectionInnerHTML?e.getSectionInnerHTML(w):new DOMParser().parseFromString(w,"text/html").querySelector(".shopify-section")?.innerHTML??w;g.innerHTML=y,m++}if(m>0){this.log(`[PromoEngine] Cart UI refreshed via section rendering (${m} element(s))`);return}}}}catch{}}this.log("refreshCartUI \u2014 falling back to DOM events"),document.dispatchEvent(new CustomEvent("cart:refresh",{bubbles:!0})),document.dispatchEvent(new CustomEvent("cart:updated",{bubbles:!0})),document.dispatchEvent(new CustomEvent("theme:cart:add",{bubbles:!0}))}async triggerEvaluation(e={}){e.emitResult!==!1&&I(v.EvaluationRequested);let n;try{n=await R.getCart()}catch(s){return this.log("Failed to fetch cart",s),null}let r=this.buildCartHash(n);if(!e.force&&r===this.lastCartHash)return this.log("Cart unchanged, skipping evaluation"),this.lastEvaluationResult;let i=n.items_subtotal_price??n.total_price;this.log("[PromoEngine] Evaluating cart \u2014",n.items.map(s=>`${s.title} \xD7${s.quantity}`).join(", ")||"empty",`| subtotal: $${(i/100).toFixed(2)}`);let o=this.evaluationAbort.start(),a=window.Shopify,c=a?.currency?.active??this.config.currency,u=a?.currency?.rate,d=u?parseFloat(u):null,p=c&&c!==this.config.currency?{id:c,handle:c.toLowerCase(),currencyCode:c,countryCode:a?.country??null,primaryLocale:a?.locale??this.config.locale,exchangeRate:d&&!isNaN(d)?d:null}:null;try{let s=await fetch(Yt,{method:"POST",headers:{"Content-Type":"application/json","X-Promo-Shop":this.config.shopDomain,"X-Promo-Key":this.config.publicKey,"X-Promo-Session":this.sessionId},body:JSON.stringify({cart:this.normalizeCart(n),customer:null,market:p,locale:this.config.locale,salesChannel:"online_store",requestedUrl:window.location.href,sessionId:this.sessionId}),signal:o});if(!s.ok){let f=await s.text().catch(()=>"(no body)");throw new Error(`Evaluation failed: ${s.status} \u2014 ${f}`)}let m=await s.json();this.lastCartHash=r,this.lastEvaluationResult=m;let _=Array.isArray(m.cartActions)?m.cartActions:[];return _.length>0?this.log("[PromoEngine] Cart actions to apply:",_.map(f=>`${f.action}(${f.variantId??f.lineKey??""}\xD7${f.quantity??0})`).join(", ")):this.log("[PromoEngine] Evaluation complete \u2014 no cart actions"),await this.applyCartActions(_),_.length>0&&await this.refreshCartUI(),e.emitResult!==!1&&I(v.EvaluationCompleted,m),m}catch(s){return s.name==="AbortError"?(this.log("Evaluation aborted (superseded by newer request)"),null):(this.log("Evaluation error",s),I(v.CartMutationError,{error:s.message}),null)}}async applyCartActions(e){for(let n of e)try{switch(n.action){case"add_line":{if(!n.variantId)break;this.log(`[PromoEngine] \u2192 add_line variantId=${n.variantId} qty=${n.quantity??1}`),await R.addLines([{variantId:n.variantId,quantity:n.quantity??1,properties:n.properties??{}}]),I(v.GiftAutoAdded,{variantId:n.variantId,quantity:n.quantity}),A("promo_engine:gift_auto_added",{variant_id:n.variantId,quantity:n.quantity,session_id:this.sessionId});break}case"update_line":{this.log(`[PromoEngine] \u2192 update_line key=${n.lineKey??"?"} qty=${n.quantity??1}`);let r=await ve(),o=(r.items.find(a=>a.key===n.lineKey)??(n.offerId?ye(r,n.offerId):null))?.key??(n.variantId?be(r,parseInt(n.variantId.split("/").pop()??n.variantId,10),n.properties??{}):null);if(!o)break;n.quantity===0?(await R.removeLine({key:o}),I(v.GiftRemoved,{lineKey:o}),A("promo_engine:gift_removed",{line_key:o,reason:"quantity_correction",session_id:this.sessionId})):(await R.updateLine({key:o,quantity:n.quantity??1,properties:n.properties}),I(v.GiftUpdated,{lineKey:o,quantity:n.quantity}));break}case"remove_line":{this.log(`[PromoEngine] \u2192 remove_line key=${n.lineKey??"?"} reason=${n.reason??"offer_disqualified"}`);let r=await ve(),o=(r.items.find(a=>a.key===n.lineKey)??(n.offerId?ye(r,n.offerId):null))?.key??(n.variantId?be(r,parseInt(n.variantId.split("/").pop()??n.variantId,10),n.properties??{}):null);if(!o)break;await R.removeLine({key:o}),I(v.GiftRemoved,{lineKey:o}),A("promo_engine:gift_removed",{line_key:o,reason:n.reason??"offer_disqualified",session_id:this.sessionId});break}}}catch(r){this.log("Cart action failed",{action:n,error:r}),I(v.CartMutationError,{action:n,error:r.message}),A("promo_engine:cart_mutation_error",{action_type:n.action,error:r.message,session_id:this.sessionId})}}buildCartHash(e){return[...e.items.map(r=>{let i=Object.entries(r.properties??{}).sort(([o],[a])=>o.localeCompare(a)).map(([o,a])=>`${o}=${String(a)}`).join(",");return[r.key,r.variant_id,r.quantity,r.final_price??r.price,r.final_line_price??r.line_price??r.price*r.quantity,i].join(":")}).sort(),String(e.items_subtotal_price??e.total_price),...e.discount_codes?.map(r=>r.code).sort()??[],e.currency].join("|")}normalizeCart(e){return{token:e.token,id:null,lines:e.items.map(n=>({key:n.key,variantId:`gid://shopify/ProductVariant/${n.variant_id}`,productId:`gid://shopify/Product/${n.product_id}`,quantity:n.quantity,priceCents:n.final_price??n.price,lineSubtotalCents:n.final_line_price??n.line_price??n.price*n.quantity,compareAtPriceCents:null,properties:n.properties??{},requiresSellingPlan:n.requires_selling_plan??!1,sellingPlanId:n.selling_plan_allocation?"has-plan":null,productHandle:n.handle,productTitle:n.title,variantTitle:n.variant_title,vendor:n.vendor,productType:n.product_type,tags:n.tags?n.tags.split(", "):[],collections:[],availableForSale:n.available??!0,inventoryPolicy:n.inventory_policy?.toUpperCase()==="CONTINUE"?"CONTINUE":"DENY",inventoryQuantity:n.inventory_quantity??0})),attributes:e.attributes??{},subtotalCents:e.items_subtotal_price??e.total_price,discountCodes:e.discount_codes?.map(n=>n.code)??[],currencyCode:e.currency,totalQuantity:e.item_count}}log(e,...n){this.config.debug&&console.info(`[PromoEngine] ${e}`,...n)}api={refreshCart:()=>this.debouncedEvaluate.flush(),evaluate:()=>this.triggerEvaluation(),validateGiftOffer:async e=>{let n=await this.triggerEvaluation({force:!0,emitResult:!1});return n?.giftSlider?.offerId===e?n.giftSlider:null},prepareCheckout:async()=>{this.debouncedEvaluate.cancel(),I(v.CheckoutPrepare),await this.triggerEvaluation()},on:(e,n)=>E(e,n)}};function gt(){let t=window.__promoEngineConfig;if(!t){console.warn("[PromoEngine] No config found. Ensure the app embed is enabled in your theme.");return}let e=new qe(t);window.PromoEngine=e.api,window.initFbtWidget=he,fe(bt()),e.init()}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",gt):gt();function yt(t={}){let{quantitySelectors:e=[".cart-count",".cart-item-count","[data-cart-count]"],customCartUpdateEvents:n=[],sectionRenderingEnabled:r=!1}=t,i=["cart:updated","cart:refresh","cart:change","cart-drawer:open","cartDrawer:open","drawer:open","theme:cart:open","turbo:cart-update","rebuy:cart-change","slide-cart:open",...n];for(let d of i)document.addEventListener(d,()=>{I(v.CartChanged)});let o=[];function a(){for(let d of e){let p=document.querySelectorAll(d);for(let s of p)o.includes(s)||(u.observe(s,{childList:!0,subtree:!0,characterData:!0}),o.push(s))}}let c=null,u=new MutationObserver(()=>{c&&clearTimeout(c),c=setTimeout(()=>I(v.CartChanged),300)});a(),new MutationObserver(()=>a()).observe(document.body,{childList:!0,subtree:!1}),r&&E(v.GiftAutoAdded,async()=>{let d=Jt();d.length>0&&await Xt(d)}),i.filter(d=>d.includes("open")).forEach(d=>{document.addEventListener(d,()=>{setTimeout(()=>{I(v.ProgressRerender),I(v.CartMessageRender)},100)})})}function Jt(){let t=document.querySelectorAll("[data-section-id]"),e=[];for(let n of t){let r=n.getAttribute("data-section-id");r&&(r.includes("cart")||r.includes("gift"))&&e.push(r)}return e}async function Xt(t){let e=t.map(n=>`sections[]=${encodeURIComponent(n)}`).join("&");try{let n=await fetch(`/cart?${e}`,{headers:{Accept:"application/json"}});if(!n.ok)return;let r=await n.json();for(let[i,o]of Object.entries(r.sections??{})){let a=document.querySelector(`[data-section-id="${i}"]`);a&&o&&(a.outerHTML=o)}}catch{}}var _e=class{endpoint;token;cartId=null;CART_ID_KEY="promo_engine_cart_id";constructor(e,n){this.endpoint=`https://${e}/api/2026-01/graphql.json`,this.token=n}async gql(e,n){let r=await fetch(this.endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Storefront-Access-Token":this.token},body:JSON.stringify({query:e,variables:n})});if(!r.ok)throw new Error(`Storefront API error: ${r.status}`);let i=await r.json();if(i.errors?.length)throw new Error(i.errors[0].message);return i.data}getStoredCartId(){try{return localStorage.getItem(this.CART_ID_KEY)}catch{return null}}storeCartId(e){try{localStorage.setItem(this.CART_ID_KEY,e)}catch{}}async getOrCreateCart(){let e=this.getStoredCartId();if(e)try{let n=await this.fetchCart(e);if(n)return this.cartId=e,n}catch{}return this.createCart()}async fetchCart(e){return(await this.gql(`query GetCart($cartId: ID!) {
        cart(id: $cartId) {
          id checkoutUrl
          lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
            cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
          }}
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          discountCodes { code applicable }
          buyerIdentity { countryCode customer { id } }
        }
      }`,{cartId:e})).cart}async createCart(){let n=(await this.gql(`mutation CartCreate {
        cartCreate {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`)).cartCreate.cart;return this.cartId=n.id,this.storeCartId(n.id),n}async addLines(e){let n=this.cartId??(await this.getOrCreateCart()).id;return(await this.gql(`mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
        cartLinesAdd(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:n,lines:e.map(i=>({merchandiseId:i.merchandiseId,quantity:i.quantity,attributes:Object.entries(i.attributes??{}).map(([o,a])=>({key:o,value:a}))}))})).cartLinesAdd.cart}async updateLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
        cartLinesUpdate(cartId: $cartId, lines: $lines) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:this.cartId,lines:e.map(r=>({id:r.id,quantity:r.quantity,attributes:Object.entries(r.attributes).map(([i,o])=>({key:i,value:o}))}))})).cartLinesUpdate.cart}async removeLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
        cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
          cart {
            id checkoutUrl
            lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
              cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
            }}
            cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
            discountCodes { code applicable }
            buyerIdentity { countryCode customer { id } }
          }
        }
      }`,{cartId:this.cartId,lineIds:e})).cartLinesRemove.cart}async applyDiscountCodes(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart { id discountCodes { code applicable } }
        }
      }`,{cartId:this.cartId,discountCodes:e})).cartDiscountCodesUpdate.cart}async updateBuyerIdentity(e,n){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { id buyerIdentity { countryCode customer { id } } }
        }
      }`,{cartId:this.cartId,buyerIdentity:{countryCode:e,...n?{customerAccessToken:n}:{}}})).cartBuyerIdentityUpdate.cart}};var Zt={position:"bottom_right",style:"icon_title",primaryColor:"#111",iconSizeRem:3.5},en=`
.pe-today-wrap {
  position: fixed; bottom: 24px; z-index: 9998;
  display: flex; flex-direction: column; align-items: flex-end; gap: 12px;
}
.pe-today-wrap.pe-left { left: 24px; align-items: flex-start; }
.pe-today-wrap.pe-right { right: 24px; }
.pe-today-trigger {
  display: flex; align-items: center; gap: 8px;
  background: var(--pe-primary, #111); color: #fff;
  border: none; border-radius: 999px; padding: 10px 16px 10px 12px;
  cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.25);
  font-size: 14px; font-weight: 600; font-family: inherit;
  transition: transform .15s, box-shadow .15s; position: relative;
}
.pe-today-trigger:hover { transform: scale(1.04); box-shadow: 0 6px 20px rgba(0,0,0,.3); }
.pe-today-icon { font-size: 20px; }
.pe-today-dot {
  position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
  background: #ef4444; border-radius: 50%; border: 2px solid #fff;
  animation: pe-pulse 2s infinite;
}
@keyframes pe-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.3); opacity: .8; }
}
.pe-today-panel {
  background: #fff; border-radius: 12px; width: 280px;
  box-shadow: 0 8px 32px rgba(0,0,0,.2); overflow: hidden;
  animation: pe-slide-up .2s ease;
}
@keyframes pe-slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.pe-today-panel-header {
  padding: 12px 16px; background: var(--pe-primary, #111); color: #fff;
  display: flex; justify-content: space-between; align-items: center;
}
.pe-today-panel-title { font-size: 14px; font-weight: 700; margin: 0; }
.pe-today-close { background: none; border: none; color: #fff; font-size: 16px; cursor: pointer; padding: 0; }
.pe-today-offers { padding: 8px 0; max-height: 320px; overflow-y: auto; }
.pe-today-offer-item {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  cursor: pointer; transition: background .12s; text-decoration: none; color: inherit;
}
.pe-today-offer-item:hover { background: #f9f9f9; }
.pe-today-offer-img { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-today-offer-info { flex: 1; min-width: 0; }
.pe-today-offer-title { font-size: 13px; font-weight: 600; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pe-today-offer-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; }
.pe-today-offer-btn { font-size: 11px; color: var(--pe-primary, #111); font-weight: 700; flex-shrink: 0; }
`;function tn({items:t,config:e,sessionId:n}){let[r,i]=q(!1);if(t.length===0)return null;let o=e.position==="bottom_left"?"pe-left":"pe-right";function a(c){if(A("promo_engine:widget_clicked",{offer_id:c.offerId,widget_type:"today_offer",session_id:n}),c.redirectUrl)try{let u=new URL(c.redirectUrl,window.location.href);if(u.protocol==="http:"||u.protocol==="https:"){window.location.href=u.href;return}}catch{}i(!1)}return l("div",{class:`pe-today-wrap ${o}`,style:{"--pe-primary":e.primaryColor},children:[r&&l("div",{class:"pe-today-panel",role:"dialog","aria-label":"Today's offers",children:[l("div",{class:"pe-today-panel-header",children:[l("h3",{class:"pe-today-panel-title",children:"Today's Offers"}),l("button",{class:"pe-today-close",onClick:()=>i(!1),"aria-label":"Close",children:"\u2715"})]}),l("div",{class:"pe-today-offers",children:t.map(c=>l("div",{class:"pe-today-offer-item",onClick:()=>a(c),role:"button",tabIndex:0,onKeyDown:u=>{u.key==="Enter"&&a(c)},children:[c.imageUrl?l("img",{class:"pe-today-offer-img",src:c.imageUrl,alt:c.title,loading:"lazy"}):l("div",{class:"pe-today-offer-img","aria-hidden":"true",children:"\u{1F381}"}),l("div",{class:"pe-today-offer-info",children:[l("p",{class:"pe-today-offer-title",children:c.title}),c.description&&l("p",{class:"pe-today-offer-desc",children:c.description})]}),l("span",{class:"pe-today-offer-btn",children:c.buttonText||"View \u2192"})]},c.offerId))})]}),l("button",{class:"pe-today-trigger",onClick:()=>{i(c=>!c),r||A("promo_engine:widget_viewed",{widget_type:"today_offer",offer_count:t.length,session_id:n})},"aria-expanded":r,"aria-haspopup":"dialog","aria-label":`${t.length} offer${t.length!==1?"s":""} available`,children:[l("span",{class:"pe-today-icon","aria-hidden":"true",children:"\u{1F381}"}),e.style==="icon_title"&&l("span",{children:"Today's Deals"}),l("span",{class:"pe-today-dot","aria-hidden":"true"})]})]})}var X=null;function vt(t,e){let n={...Zt,...t};if(!document.getElementById("pe-today-styles")){let r=document.createElement("style");r.id="pe-today-styles",r.textContent=en,document.head.appendChild(r)}X||(X=document.createElement("div"),X.id="pe-today-offer-root",document.body.appendChild(X)),E(v.EvaluationCompleted,r=>{let i=(Array.isArray(r.qualifiedOffers)?r.qualifiedOffers:[]).map(o=>({offerId:o.offerId,title:o.type+" offer",description:"",imageUrl:null,buttonText:"View",redirectUrl:null,badgeText:null}));N(D(tn,{items:i,config:n,sessionId:e}),X)})}function xt(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function nn(t,e){return[...e].sort((n,r)=>r.minQuantity-n.minQuantity).find(n=>t>=n.minQuantity)??null}function rn({config:t,sessionId:e}){let[n,r]=q(0),[i,o]=q(new Map),[a,c]=q(""),u="name_asc",[d,p]=q(!1),[s,m]=q(!1),_=t.layoutMode==="one_step_per_page",f=_?[t.steps[n]].filter(Boolean):t.steps,w=Le(()=>{let b=0;for(let P of i.values())for(let O of P.values())b+=O;return b},[i]),g=nn(w,t.tiers);function y(b,P,O){o(M=>{let x=new Map(M),T=new Map(x.get(b)??[]);return O===0?T.delete(P):T.set(P,O),x.set(b,T),x})}function h(b){return[...i.get(b)?.values()??[]].reduce((P,O)=>P+O,0)}function S(b){let P=h(b.id);return P>=b.minQuantity&&(b.maxQuantity===null||P<=b.maxQuantity)}async function k(){if(!d){p(!0);try{let b=[];for(let[P,O]of i.entries())for(let[M,x]of O.entries())b.push({variantId:M,quantity:x,properties:{_promo_engine_line_type:"bundle_component",_promo_engine_offer_id:t.offerId,_promo_engine_bundle_id:t.bundleId,_promo_engine_bundle_step_id:P,_promo_engine_bundle_title:t.title}});await R.addLines(b),m(!0),I(v.CartChanged),A("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,bundle_id:t.bundleId,total_qty:w,session_id:e})}finally{p(!1)}}}return s?l("div",{class:"pe-bb-success",children:[l("p",{children:"\u2713 Bundle added to cart!"}),l("button",{onClick:()=>m(!1),children:"Build Another"})]}):l("div",{class:"pe-bb",children:[l("h1",{class:"pe-bb-title",children:t.title}),t.description&&l("p",{class:"pe-bb-desc",children:t.description}),t.tiers.length>0&&l("div",{class:"pe-bb-tiers",children:t.tiers.map(b=>l("div",{class:`pe-bb-tier${g?.minQuantity===b.minQuantity?" pe-active":""}`,children:[l("span",{class:"pe-bb-tier-label",children:b.label}),l("span",{class:"pe-bb-tier-qty",children:["Buy ",b.minQuantity,"+"]}),l("span",{class:"pe-bb-tier-discount",children:b.discountType==="percentage"?`-${Math.round(b.discountValue)}%`:xt(b.discountValue,t.currency)})]},b.minQuantity))}),f.map(b=>{let P=h(b.id),O=S(b),M=b.products.filter(x=>!a||x.title.toLowerCase().includes(a.toLowerCase())).sort((x,T)=>u==="price_asc"?x.priceCents-T.priceCents:u==="price_desc"?T.priceCents-x.priceCents:x.title.localeCompare(T.title));return l("div",{class:"pe-bb-step",children:[l("div",{class:"pe-bb-step-header",children:[l("h2",{class:"pe-bb-step-title",children:[_&&`Step ${n+1} of ${t.steps.length}: `,b.title]}),b.subtitle&&l("p",{class:"pe-bb-step-subtitle",children:b.subtitle}),l("p",{class:"pe-bb-step-count",children:[P," selected",b.minQuantity>0&&` (min ${b.minQuantity})`,b.maxQuantity&&` (max ${b.maxQuantity})`,O&&" \u2713"]})]}),b.searchEnabled&&l("input",{class:"pe-bb-search",type:"text",placeholder:"Search products...",value:a,onInput:x=>c(x.target.value),"aria-label":"Search products in this step"}),l("div",{class:"pe-bb-products",children:M.map(x=>{let T=i.get(b.id)?.get(x.variantId)??0,ze=b.maxQuantity!==null&&P>=b.maxQuantity&&T===0;return l("div",{class:`pe-bb-product${T>0?" pe-selected":""}${x.isAvailable?"":" pe-unavailable"}${ze?" pe-at-max":""}`,children:[x.imageUrl&&l("img",{class:"pe-bb-img",src:x.imageUrl,alt:x.title,loading:"lazy"}),l("p",{class:"pe-bb-product-name",children:x.title}),x.variantTitle&&l("p",{class:"pe-bb-variant",children:x.variantTitle}),l("p",{class:"pe-bb-price",children:xt(x.priceCents,t.currency)}),x.isAvailable?l("div",{class:"pe-bb-qty-ctrl",children:[l("button",{onClick:()=>y(b.id,x.variantId,Math.max(0,T-1)),disabled:T===0,"aria-label":`Remove ${x.title}`,children:"\u2212"}),l("span",{class:"pe-bb-qty",children:T}),l("button",{onClick:()=>y(b.id,x.variantId,T+1),disabled:ze,"aria-label":`Add ${x.title}`,children:"+"})]}):l("span",{class:"pe-bb-oos",children:"Out of stock"})]},x.variantId)})})]},b.id)}),l("div",{class:"pe-bb-footer",children:_?l("div",{class:"pe-bb-nav",children:[n>0&&l("button",{class:"pe-bb-btn-prev",onClick:()=>r(b=>b-1),children:"\u2190 Previous"}),n<t.steps.length-1?l("button",{class:"pe-bb-btn-next",onClick:()=>{A("promo_engine:bundle_step_completed",{offer_id:t.offerId,step_index:n,session_id:e}),r(b=>b+1)},disabled:!t.steps[n]||!S(t.steps[n]),children:"Next \u2192"}):l("button",{class:"pe-bb-btn-add",onClick:k,disabled:d||!t.steps.every(b=>S(b)),children:d?"Adding\u2026":`Add Bundle to Cart${g?` (${g.label})`:""}`})]}):l("div",{class:"pe-bb-summary",children:[l("p",{class:"pe-bb-total",children:[w," items selected"]}),g&&l("p",{class:"pe-bb-saving",children:["\u{1F4B0} ",g.label," applied!"]}),l("button",{class:"pe-bb-btn-add",onClick:k,disabled:d||!t.steps.every(b=>S(b)),children:d?"Adding\u2026":"Add Bundle to Cart"})]})})]})}function wt(t,e,n){N(D(rn,{config:e,sessionId:n}),t)}var Oe=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.renderSkeleton(),this.unsubscribe=E(v.EvaluationCompleted,e=>{let n=(Array.isArray(e.progressBars)?e.progressBars:[]).find(r=>r.offerId===this.offerId||r.widgetId===this.widgetId);n&&this.renderPayload(n)})}disconnectedCallback(){this.unsubscribe?.()}renderSkeleton(){this.shadowRoot&&(this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; font-family: inherit; }
        .pe-pb-wrap { padding: 12px 0; }
        .pe-pb-msg { font-size: 14px; margin-bottom: 8px; color: inherit; }
        .pe-pb-track {
          background: #e5e7eb; border-radius: 999px; height: 6px; overflow: hidden;
        }
        .pe-pb-fill {
          background: #111; height: 100%; border-radius: 999px;
          transition: width .4s ease; width: 0%;
        }
        .pe-pb-fill.pe-goal { background: #059669; }
      </style>
      <div class="pe-pb-wrap" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
        <p class="pe-pb-msg"></p>
        <div class="pe-pb-track"><div class="pe-pb-fill"></div></div>
      </div>
    `)}renderPayload(e){if(!this.shadowRoot)return;let n=this.shadowRoot.querySelector(".pe-pb-wrap"),r=this.shadowRoot.querySelector(".pe-pb-msg"),i=this.shadowRoot.querySelector(".pe-pb-fill");if(!n||!r||!i)return;let o=Math.min(100,Math.round(e.progressPercent)),a=e.isGoalReached?e.messageAfterGoal:e.messageBeforeGoal;r.textContent=this.interpolateMessage(a,e),i.style.width=`${o}%`,i.classList.toggle("pe-goal",e.isGoalReached),n.setAttribute("aria-valuenow",String(o)),this.setAttribute("aria-label",`Progress: ${o}%`)}interpolateMessage(e,n){let r=n.targetCents-n.currentCents,i=(n.targetQuantity??0)-n.currentQuantity,o=this.getAttribute("currency")??"USD",a=c=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:o}).format(c/100);return e.replace("{{remaining_amount}}",a(Math.max(0,r))).replace("{{remaining_quantity}}",String(Math.max(0,i))).replace("{{current_amount}}",a(n.currentCents)).replace("{{target_amount}}",a(n.targetCents))}};customElements.define("promo-progress-bar",Oe);var je=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let n=(Array.isArray(e.cartMessages)?e.cartMessages:[]).filter(r=>r.offerId===this.offerId||r.widgetId===this.widgetId).sort((r,i)=>r.priority-i.priority);this.render(n[0]??null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e){this.shadowRoot.innerHTML="<style>:host { display: none; }</style>";return}let r={progress:"#f59e0b",success:"#059669",info:"#3b82f6"}[e.type]??"#111",i=this.sanitize(e.message);this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; }
        .pe-msg {
          padding: 10px 14px;
          border-left: 3px solid ${r};
          background: ${r}18;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
          line-height: 1.5;
          color: inherit;
        }
      </style>
      <div class="pe-msg" role="status" aria-live="polite">${i}</div>
    `}sanitize(e){let n=document.createElement("div");return n.textContent=e,n.innerHTML}};customElements.define("promo-cart-message",je);function me(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function on(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var an=`
:host { display: inline-block; }
.pe-gift-icon-wrap {
  display: inline-flex; align-items: center; gap: 6px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 999px;
  padding: 4px 12px; min-height: 48px; font-size: 13px; font-weight: 600; color: #059669;
  cursor: pointer; transition: background .15s;
  font: inherit;
}
.pe-gift-icon-wrap:hover { background: #dcfce7; }
.pe-gift-icon-wrap:focus-visible, .pe-thumb-cta:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
.pe-gift-icon-wrap.pe-hidden { display: none; }
.pe-gift-emoji { font-size: 15px; }
@media (prefers-reduced-motion: reduce) { .pe-gift-icon-wrap { transition: none; } }
`,De=class extends HTMLElement{offerId="";variantId="";unsubscribe=null;unsubscribeProductChanged=null;countdownTimer=null;activeOfferId="";connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.shadowRoot||this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let n=Array.isArray(e.qualifiedOffers)?this.offerId?e.qualifiedOffers.find(r=>r.offerId===this.offerId):e.qualifiedOffers[0]:null;this.render(n?{offerId:n.offerId,offerName:"Free Gift Available"}:null)}),this.unsubscribeProductChanged=E(v.ProductChanged,e=>{this.variantId=e.variantId})}disconnectedCallback(){this.unsubscribe?.(),this.unsubscribeProductChanged?.(),this.countdownTimer!==null&&window.clearTimeout(this.countdownTimer)}render(e){if(!this.shadowRoot)return;this.activeOfferId=e?.offerId??"",this.countdownTimer!==null&&(window.clearTimeout(this.countdownTimer),this.countdownTimer=null);let n=me(this.getAttribute("label")??"Free Gift"),r=parseInt(this.getAttribute("countdown-seconds")??"0",10),i=me(e?.offerName??""),o=me(this.offerId);this.shadowRoot.innerHTML=`
      <style>${an}</style>
      <button type="button" class="pe-gift-icon-wrap${e?"":" pe-hidden"}"
           aria-label="View free gift offer"
           title="${i}">
        <span class="pe-gift-emoji" aria-hidden="true">\u{1F381}</span>
        <span>${n}</span>
        ${r>0?`<span class="pe-countdown" id="cd-${o}"></span>`:""}
      </button>
    `,e&&(this.shadowRoot.querySelector(".pe-gift-icon-wrap")?.addEventListener("click",()=>{I(v.GiftSliderRequested,{offerId:this.activeOfferId}),A("promo_engine:widget_clicked",{offer_id:this.activeOfferId,widget_type:"gift_icon"})}),r>0&&this.startCountdown(r))}startCountdown(e){if(!this.shadowRoot)return;let n=e,r=()=>{let i=this.shadowRoot?.getElementById(`cd-${this.offerId}`);if(!i)return;let o=Math.floor(n/60),a=n%60;i.textContent=` (${o}:${String(a).padStart(2,"0")})`,n--,n>=0&&(this.countdownTimer=window.setTimeout(r,1e3))};r()}};customElements.get("promo-gift-icon")||customElements.define("promo-gift-icon",De);var Ct=`
:host { display: block; }
.pe-thumb-wrap {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px;
  background: #fff; max-width: 280px;
}
.pe-thumb-wrap.pe-hidden { display: none; }
.pe-thumb-offer-name { font-size: 11px; font-weight: 700; color: #059669; text-transform: uppercase; letter-spacing: .5px; margin: 0 0 8px; }
.pe-thumb-products { display: flex; gap: 6px; flex-wrap: wrap; }
.pe-thumb-product { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.pe-thumb-img { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid #e5e7eb; }
.pe-thumb-img-ph { width: 48px; height: 48px; background: #f3f4f6; border-radius: 4px; border: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: center; font-size: 20px; }
.pe-thumb-name { font-size: 10px; color: #374151; text-align: center; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-thumb-count { font-size: 12px; color: #6b7280; margin-top: 6px; }
.pe-thumb-cta { margin-top: 8px; padding: 8px 0; min-height: 48px; border: 0; background: transparent; font-size: 12px; color: #111; font-weight: 600; cursor: pointer; text-decoration: underline; }
`,Me=class extends HTMLElement{offerId="";unsubscribe=null;activeOfferId="";connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.shadowRoot||this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=E(v.EvaluationCompleted,e=>{let n=Array.isArray(e.qualifiedOffers)?this.offerId?e.qualifiedOffers.find(i=>i.offerId===this.offerId):e.qualifiedOffers[0]:null,r=e.giftSlider;this.activeOfferId=n?.offerId??"",this.render(n&&r?.offerId===n.offerId?r.selectableGifts:null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e||e.length===0){this.shadowRoot.innerHTML=`<style>${Ct}</style><div class="pe-thumb-wrap pe-hidden"></div>`;return}let r=e.slice(0,4).map(i=>{let o=on(i.imageUrl),a=me(i.title);return o?`<div class="pe-thumb-product">
               <img class="pe-thumb-img" src="${o}" alt="${a}" loading="lazy"/>
               <span class="pe-thumb-name">${a}</span>
             </div>`:`<div class="pe-thumb-product">
               <div class="pe-thumb-img-ph" aria-hidden="true">\u{1F381}</div>
               <span class="pe-thumb-name">${a}</span>
             </div>`}).join("");this.shadowRoot.innerHTML=`
      <style>${Ct}</style>
      <div class="pe-thumb-wrap">
        <p class="pe-thumb-offer-name">\u{1F381} Free Gift</p>
        <div class="pe-thumb-products">${r}</div>
        ${e.length>4?`<p class="pe-thumb-count">+${e.length-4} more gifts available</p>`:""}
        <button type="button" class="pe-thumb-cta">Choose your gift \u2192</button>
      </div>
    `,this.shadowRoot.querySelector(".pe-thumb-cta")?.addEventListener("click",()=>{I(v.GiftSliderRequested,{offerId:this.activeOfferId})})}};customElements.get("promo-gift-thumbnail")||customElements.define("promo-gift-thumbnail",Me);var sn=`
:host { display: block; }
.pe-vd-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; margin: 16px 0; }
.pe-vd-title { padding: 10px 14px; background: #f9fafb; font-size: 13px; font-weight: 700; border-bottom: 1px solid #e5e7eb; }
.pe-vd-tier {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid #f3f4f6; cursor: pointer;
  transition: background .1s;
}
.pe-vd-tier:last-child { border-bottom: none; }
.pe-vd-tier:hover { background: #f9fafb; }
.pe-vd-tier.pe-active { background: #f0fdf4; border-left: 3px solid #059669; }
.pe-vd-qty { font-size: 14px; font-weight: 600; }
.pe-vd-label { font-size: 12px; color: #059669; font-weight: 700; background: #dcfce7; padding: 2px 8px; border-radius: 999px; }
.pe-vd-price { text-align: right; }
.pe-vd-price-original { font-size: 12px; color: #9ca3af; text-decoration: line-through; }
.pe-vd-price-discounted { font-size: 14px; font-weight: 700; color: #059669; }
`,Ue=class extends HTMLElement{offerId="";variantId="";currency="USD";unsubscribeVariant=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.currency=this.getAttribute("currency")??"USD",this.attachShadow({mode:"open"}),this.loadAndRender(),this.unsubscribeVariant=E(v.ProductChanged,e=>{this.variantId=e.variantId,this.setAttribute("variant-id",e.variantId),this.loadAndRender()})}disconnectedCallback(){this.unsubscribeVariant?.()}async loadAndRender(){if(!(!this.offerId||!this.variantId)&&this.shadowRoot)try{let e=window.Shopify?.shop??location.hostname,n=await fetch(`/apps/promo-engine/product-customizations?offer_id=${encodeURIComponent(this.offerId)}&variant_id=${encodeURIComponent(this.variantId)}`,{headers:{"X-Promo-Shop":e}});if(!n.ok){this.renderEmpty();return}let r=await n.json();r.volumeDiscount?this.renderTiers(r.volumeDiscount):this.renderEmpty()}catch{this.renderEmpty()}}renderTiers(e){if(!this.shadowRoot)return;let n=i=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:e.currency}).format(i/100),r=e.tiers.map((i,o)=>`
        <div class="pe-vd-tier ${o===0?"pe-active":""}"
             data-qty="${i.minQuantity}"
             role="button"
             tabindex="0"
             aria-label="Buy ${i.minQuantity}+ for ${n(i.discountedPriceCents)} each">
          <div>
            <p class="pe-vd-qty">${i.minQuantity===1?"1 item":`${i.minQuantity}+ items`}</p>
          </div>
          <span class="pe-vd-label">${i.label||(i.discountType==="percentage"?`-${Math.round(i.discountValue)}%`:"Deal")}</span>
          <div class="pe-vd-price">
            ${i.originalPriceCents!==i.discountedPriceCents?`<p class="pe-vd-price-original">${n(i.originalPriceCents)}</p>`:""}
            <p class="pe-vd-price-discounted">${n(i.discountedPriceCents)} each</p>
          </div>
        </div>`).join("");this.shadowRoot.innerHTML=`
      <style>${sn}</style>
      <div class="pe-vd-wrap">
        <div class="pe-vd-title">Volume Discounts</div>
        ${r}
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-vd-tier").forEach(i=>{i.addEventListener("click",()=>{let o=parseInt(i.dataset.qty??"1",10),a=document.querySelector('input[name="quantity"]');a&&(a.value=String(o),a.dispatchEvent(new Event("change",{bubbles:!0}))),this.shadowRoot?.querySelectorAll(".pe-vd-tier").forEach(c=>c.classList.remove("pe-active")),i.classList.add("pe-active")})})}renderEmpty(){this.shadowRoot&&(this.shadowRoot.innerHTML="<style>:host { display: none; }</style>")}};customElements.define("promo-volume-discount",Ue);function Z(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function dn(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var It=`
:host { display: block; }
.pe-tob-wrap { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.pe-tob-header { background: #111; color: #fff; padding: 10px 14px; font-size: 13px; font-weight: 700; }
.pe-tob-items { }
.pe-tob-item {
  display: flex; align-items: center; gap: 12px; padding: 12px 14px;
  border-bottom: 1px solid #f3f4f6; cursor: pointer; transition: background .12s;
  text-decoration: none; color: inherit;
}
.pe-tob-item:last-child { border-bottom: none; }
.pe-tob-item:hover { background: #f9fafb; }
.pe-tob-img { width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: #f3f4f6; flex-shrink: 0; }
.pe-tob-info { flex: 1; min-width: 0; }
.pe-tob-title { font-size: 13px; font-weight: 600; margin: 0; }
.pe-tob-desc { font-size: 11px; color: #6b7280; margin: 2px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pe-tob-badge { font-size: 11px; color: #059669; font-weight: 700; flex-shrink: 0; }
.pe-tob-empty { display: none; }
`,Ne=class extends HTMLElement{filterOfferIds=[];unsubscribe=null;connectedCallback(){let e=this.getAttribute("offer-ids");this.filterOfferIds=e?e.split(",").map(n=>n.trim()):[],this.attachShadow({mode:"open"}),this.render([]),this.unsubscribe=E(v.EvaluationCompleted,n=>{let r=Array.isArray(n.qualifiedOffers)?n.qualifiedOffers:[];this.filterOfferIds.length>0&&(r=r.filter(i=>this.filterOfferIds.includes(i.offerId))),this.render(r.map(i=>({offerId:i.offerId,title:i.type,description:"",imageUrl:null,badgeText:"Active"})))})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let n=Z(this.getAttribute("title")??"Today's Offers");if(e.length===0){this.shadowRoot.innerHTML=`<style>${It}</style><div class="pe-tob-empty"></div>`;return}let r=e.map(i=>{let o=Z(i.offerId),a=Z(i.title),c=Z(i.description),u=Z(i.badgeText),d=dn(i.imageUrl);return`
      <div class="pe-tob-item" data-offer="${o}" role="button" tabindex="0">
        ${d?`<img class="pe-tob-img" src="${d}" alt="${a}" loading="lazy">`:'<div class="pe-tob-img" aria-hidden="true">\u{1F381}</div>'}
        <div class="pe-tob-info">
          <p class="pe-tob-title">${a}</p>
          ${c?`<p class="pe-tob-desc">${c}</p>`:""}
        </div>
        <span class="pe-tob-badge">${u}</span>
      </div>
    `}).join("");this.shadowRoot.innerHTML=`
      <style>${It}</style>
      <div class="pe-tob-wrap">
        <div class="pe-tob-header">${n}</div>
        <div class="pe-tob-items">${r}</div>
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-tob-item").forEach(i=>{let o=i.dataset.offer??"";i.addEventListener("click",()=>{A("promo_engine:widget_clicked",{offer_id:o,widget_type:"today_offer_block"})})})}};customElements.define("promo-today-offer-block",Ne);return $t(cn);})();
