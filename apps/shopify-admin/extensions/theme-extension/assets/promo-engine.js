"use strict";var PromoEngine=(()=>{var pe=Object.defineProperty;var _t=Object.getOwnPropertyDescriptor;var mt=Object.getOwnPropertyNames;var gt=Object.prototype.hasOwnProperty;var ht=(t,e)=>{for(var r in e)pe(t,r,{get:e[r],enumerable:!0})},bt=(t,e,r,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of mt(e))!gt.call(t,i)&&i!==r&&pe(t,i,{get:()=>e[i],enumerable:!(n=_t(e,i))||n.enumerable});return t};var yt=t=>bt(pe({},"__esModule",{value:!0}),t);var Wt={};ht(Wt,{AbortableRequest:()=>X,AjaxCartAdapter:()=>U,PromoEvents:()=>x,StorefrontApiAdapter:()=>K,debounce:()=>Re,emit:()=>P,initBundleBuilder:()=>pt,initCartDrawerIntegration:()=>$e,initFbtWidget:()=>dt,initGiftSlider:()=>st,initTodayOfferWidget:()=>lt,on:()=>k,publishAnalytics:()=>T});var x={CartChanged:"promo-engine:cart-changed",EvaluationRequested:"promo-engine:evaluation-requested",EvaluationCompleted:"promo-engine:evaluation-completed",GiftAutoAdded:"promo-engine:gift-auto-added",GiftAdded:"promo-engine:gift-added",GiftUpdated:"promo-engine:gift-updated",GiftRemoved:"promo-engine:gift-removed",GiftSliderRequested:"promo-engine:gift-slider-requested",GiftSliderClosed:"promo-engine:gift-slider-closed",ProductChanged:"promo-engine:product-changed",CartMessageRender:"promo-engine:cart-message-render",ProgressRerender:"promo-engine:progress-rerender",TodayOfferRender:"promo-engine:today-offer-render",BundleInit:"promo-engine:bundle-init",UpsellInit:"promo-engine:upsell-init",CheckoutPrepare:"promo-engine:checkout-prepare",CartMutationError:"promo-engine:cart-mutation-error",InventoryFailure:"promo-engine:inventory-failure"};function P(t,e){window.dispatchEvent(new CustomEvent(t,{detail:e,bubbles:!0}))}function k(t,e,r){let n=i=>e(i.detail);return window.addEventListener(t,n,r),()=>window.removeEventListener(t,n)}function T(t,e){typeof window.analytics?.publish=="function"&&window.analytics.publish(t,e)}function $e(t={}){let{quantitySelectors:e=[".cart-count",".cart-item-count","[data-cart-count]"],customCartUpdateEvents:r=[],sectionRenderingEnabled:n=!1}=t,i=["cart:updated","cart:refresh","cart:change","cart-drawer:open","cartDrawer:open","drawer:open","theme:cart:open","turbo:cart-update","rebuy:cart-change","slide-cart:open",...r];for(let c of i)document.addEventListener(c,()=>{P(x.CartChanged)});let o=[];function s(){for(let c of e){let _=document.querySelectorAll(c);for(let a of _)o.includes(a)||(u.observe(a,{childList:!0,subtree:!0,characterData:!0}),o.push(a))}}let l=null,u=new MutationObserver(()=>{l&&clearTimeout(l),l=setTimeout(()=>P(x.CartChanged),300)});s(),new MutationObserver(()=>s()).observe(document.body,{childList:!0,subtree:!1}),n&&k(x.GiftAutoAdded,async()=>{let c=vt();c.length>0&&await xt(c)}),i.filter(c=>c.includes("open")).forEach(c=>{document.addEventListener(c,()=>{setTimeout(()=>{P(x.ProgressRerender),P(x.CartMessageRender)},100)})})}function vt(){let t=document.querySelectorAll("[data-section-id]"),e=[];for(let r of t){let n=r.getAttribute("data-section-id");n&&(n.includes("cart")||n.includes("gift"))&&e.push(n)}return e}async function xt(t){let e=t.map(r=>`sections[]=${encodeURIComponent(r)}`).join("&");try{let r=await fetch(`/cart?${e}`,{headers:{Accept:"application/json"}});if(!r.ok)return;let n=await r.json();for(let[i,o]of Object.entries(n.sections??{})){let s=document.querySelector(`[data-section-id="${i}"]`);s&&o&&(s.outerHTML=o)}}catch{}}var Le=Promise.resolve();function G(t){return new Promise((e,r)=>{Le=Le.then(t).then(e,r)})}async function N(t,e){let r=await fetch(t,{...e,headers:{"Content-Type":"application/json",Accept:"application/json",...e?.headers}});if(!r.ok){let n=await r.text();throw new Error(`Cart API error ${r.status}: ${n}`)}return r.json()}var U={async getCart(){return N(`${window.Shopify?.routes?.root??"/"}cart.js`)},async addLines(t){return G(()=>N(`${window.Shopify?.routes?.root??"/"}cart/add.js`,{method:"POST",body:JSON.stringify({items:t.map(e=>({id:parseInt(e.variantId.split("/").pop()??e.variantId,10),quantity:e.quantity,properties:e.properties}))})}))},async updateLine(t){return G(()=>N(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:t.quantity,...t.properties?{properties:t.properties}:{}})}))},async removeLine(t){return G(()=>N(`${window.Shopify?.routes?.root??"/"}cart/change.js`,{method:"POST",body:JSON.stringify({id:t.key,quantity:0})}))},async applyDiscountCode(t){return G(()=>N(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:t})}))},async removeDiscountCode(){return G(()=>N(`${window.Shopify?.routes?.root??"/"}cart/update.js`,{method:"POST",body:JSON.stringify({discount:""})}))}};var K=class{endpoint;token;cartId=null;CART_ID_KEY="promo_engine_cart_id";constructor(e,r){this.endpoint=`https://${e}/api/2026-01/graphql.json`,this.token=r}async gql(e,r){let n=await fetch(this.endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Storefront-Access-Token":this.token},body:JSON.stringify({query:e,variables:r})});if(!n.ok)throw new Error(`Storefront API error: ${n.status}`);let i=await n.json();if(i.errors?.length)throw new Error(i.errors[0].message);return i.data}getStoredCartId(){try{return localStorage.getItem(this.CART_ID_KEY)}catch{return null}}storeCartId(e){try{localStorage.setItem(this.CART_ID_KEY,e)}catch{}}async getOrCreateCart(){let e=this.getStoredCartId();if(e)try{let r=await this.fetchCart(e);if(r)return this.cartId=e,r}catch{}return this.createCart()}async fetchCart(e){return(await this.gql(`query GetCart($cartId: ID!) {
        cart(id: $cartId) {
          id checkoutUrl
          lines(first: 100) { nodes { id quantity merchandise { id } attributes { key value }
            cost { amountPerQuantity { amount currencyCode } subtotalAmount { amount currencyCode } }
          }}
          cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
          discountCodes { code applicable }
          buyerIdentity { countryCode customer { id } }
        }
      }`,{cartId:e})).cart}async createCart(){let r=(await this.gql(`mutation CartCreate {
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
      }`)).cartCreate.cart;return this.cartId=r.id,this.storeCartId(r.id),r}async addLines(e){let r=this.cartId??(await this.getOrCreateCart()).id;return(await this.gql(`mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
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
      }`,{cartId:r,lines:e.map(i=>({merchandiseId:i.merchandiseId,quantity:i.quantity,attributes:Object.entries(i.attributes??{}).map(([o,s])=>({key:o,value:s}))}))})).cartLinesAdd.cart}async updateLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
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
      }`,{cartId:this.cartId,lines:e.map(n=>({id:n.id,quantity:n.quantity,attributes:Object.entries(n.attributes).map(([i,o])=>({key:i,value:o}))}))})).cartLinesUpdate.cart}async removeLines(e){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
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
      }`,{cartId:this.cartId,discountCodes:e})).cartDiscountCodesUpdate.cart}async updateBuyerIdentity(e,r){if(!this.cartId)throw new Error("No active cart");return(await this.gql(`mutation CartBuyerIdentityUpdate($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
        cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) {
          cart { id buyerIdentity { countryCode customer { id } } }
        }
      }`,{cartId:this.cartId,buyerIdentity:{countryCode:e,...r?{customerAccessToken:r}:{}}})).cartBuyerIdentityUpdate.cart}};function Re(t,e){let r=null,n=null;function i(...l){n=l,r!==null&&clearTimeout(r),r=setTimeout(()=>{r=null,n&&t(...n)},e)}function o(){r!==null&&(clearTimeout(r),r=null)}function s(){o(),n&&t(...n)}return{call:i,cancel:o,flush:s}}var X=class{controller=null;start(){return this.controller&&this.controller.abort("superseded"),this.controller=new AbortController,this.controller.signal}cancel(){this.controller&&(this.controller.abort("cancelled"),this.controller=null)}};var ae,w,ze,wt,j,qe,He,Oe,ue,ee,Q,je,ge,fe,_e,Ct,ne={},ie=[],It=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,se=Array.isArray;function H(t,e){for(var r in e)t[r]=e[r];return t}function he(t){t&&t.parentNode&&t.parentNode.removeChild(t)}function D(t,e,r){var n,i,o,s={};for(o in e)o=="key"?n=e[o]:o=="ref"?i=e[o]:s[o]=e[o];if(arguments.length>2&&(s.children=arguments.length>3?ae.call(arguments,2):r),typeof t=="function"&&t.defaultProps!=null)for(o in t.defaultProps)s[o]===void 0&&(s[o]=t.defaultProps[o]);return te(t,s,n,i,null)}function te(t,e,r,n,i){var o={type:t,props:e,key:r,ref:n,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:i??++ze,__i:-1,__u:0};return i==null&&w.vnode!=null&&w.vnode(o),o}function M(t){return t.children}function re(t,e){this.props=t,this.context=e}function F(t,e){if(e==null)return t.__?F(t.__,t.__i+1):null;for(var r;e<t.__k.length;e++)if((r=t.__k[e])!=null&&r.__e!=null)return r.__e;return typeof t.type=="function"?F(t):null}function kt(t){if(t.__P&&t.__d){var e=t.__v,r=e.__e,n=[],i=[],o=H({},e);o.__v=e.__v+1,w.vnode&&w.vnode(o),be(t.__P,o,e,t.__n,t.__P.namespaceURI,32&e.__u?[r]:null,n,r??F(e),!!(32&e.__u),i),o.__v=e.__v,o.__.__k[o.__i]=o,Ge(n,o,i),e.__e=e.__=null,o.__e!=r&&Be(o)}}function Be(t){if((t=t.__)!=null&&t.__c!=null)return t.__e=t.__c.base=null,t.__k.some(function(e){if(e!=null&&e.__e!=null)return t.__e=t.__c.base=e.__e}),Be(t)}function Me(t){(!t.__d&&(t.__d=!0)&&j.push(t)&&!oe.__r++||qe!=w.debounceRendering)&&((qe=w.debounceRendering)||He)(oe)}function oe(){try{for(var t,e=1;j.length;)j.length>e&&j.sort(Oe),t=j.shift(),e=j.length,kt(t)}finally{j.length=oe.__r=0}}function Ne(t,e,r,n,i,o,s,l,u,c,_){var a,g,p,v,C,f,h,y=n&&n.__k||ie,$=e.length;for(u=St(r,e,y,u,$),a=0;a<$;a++)(p=r.__k[a])!=null&&(g=p.__i!=-1&&y[p.__i]||ne,p.__i=a,f=be(t,p,g,i,o,s,l,u,c,_),v=p.__e,p.ref&&g.ref!=p.ref&&(g.ref&&ye(g.ref,null,p),_.push(p.ref,p.__c||v,p)),C==null&&v!=null&&(C=v),(h=!!(4&p.__u))||g.__k===p.__k?(u=Fe(p,u,t,h),h&&g.__e&&(g.__e=null)):typeof p.type=="function"&&f!==void 0?u=f:v&&(u=v.nextSibling),p.__u&=-7);return r.__e=C,u}function St(t,e,r,n,i){var o,s,l,u,c,_=r.length,a=_,g=0;for(t.__k=new Array(i),o=0;o<i;o++)(s=e[o])!=null&&typeof s!="boolean"&&typeof s!="function"?(typeof s=="string"||typeof s=="number"||typeof s=="bigint"||s.constructor==String?s=t.__k[o]=te(null,s,null,null,null):se(s)?s=t.__k[o]=te(M,{children:s},null,null,null):s.constructor===void 0&&s.__b>0?s=t.__k[o]=te(s.type,s.props,s.key,s.ref?s.ref:null,s.__v):t.__k[o]=s,u=o+g,s.__=t,s.__b=t.__b+1,l=null,(c=s.__i=At(s,r,u,a))!=-1&&(a--,(l=r[c])&&(l.__u|=2)),l==null||l.__v==null?(c==-1&&(i>_?g--:i<_&&g++),typeof s.type!="function"&&(s.__u|=4)):c!=u&&(c==u-1?g--:c==u+1?g++:(c>u?g--:g++,s.__u|=4))):t.__k[o]=null;if(a)for(o=0;o<_;o++)(l=r[o])!=null&&(2&l.__u)==0&&(l.__e==n&&(n=F(l)),Ve(l,l));return n}function Fe(t,e,r,n){var i,o;if(typeof t.type=="function"){for(i=t.__k,o=0;i&&o<i.length;o++)i[o]&&(i[o].__=t,e=Fe(i[o],e,r,n));return e}t.__e!=e&&(n&&(e&&t.type&&!e.parentNode&&(e=F(t)),r.insertBefore(t.__e,e||null)),e=t.__e);do e=e&&e.nextSibling;while(e!=null&&e.nodeType==8);return e}function At(t,e,r,n){var i,o,s,l=t.key,u=t.type,c=e[r],_=c!=null&&(2&c.__u)==0;if(c===null&&l==null||_&&l==c.key&&u==c.type)return r;if(n>(_?1:0)){for(i=r-1,o=r+1;i>=0||o<e.length;)if((c=e[s=i>=0?i--:o++])!=null&&(2&c.__u)==0&&l==c.key&&u==c.type)return s}return-1}function Ue(t,e,r){e[0]=="-"?t.setProperty(e,r??""):t[e]=r==null?"":typeof r!="number"||It.test(e)?r:r+"px"}function Z(t,e,r,n,i){var o,s;e:if(e=="style")if(typeof r=="string")t.style.cssText=r;else{if(typeof n=="string"&&(t.style.cssText=n=""),n)for(e in n)r&&e in r||Ue(t.style,e,"");if(r)for(e in r)n&&r[e]==n[e]||Ue(t.style,e,r[e])}else if(e[0]=="o"&&e[1]=="n")o=e!=(e=e.replace(je,"$1")),s=e.toLowerCase(),e=s in t||e=="onFocusOut"||e=="onFocusIn"?s.slice(2):e.slice(2),t.l||(t.l={}),t.l[e+o]=r,r?n?r[Q]=n[Q]:(r[Q]=ge,t.addEventListener(e,o?_e:fe,o)):t.removeEventListener(e,o?_e:fe,o);else{if(i=="http://www.w3.org/2000/svg")e=e.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(e!="width"&&e!="height"&&e!="href"&&e!="list"&&e!="form"&&e!="tabIndex"&&e!="download"&&e!="rowSpan"&&e!="colSpan"&&e!="role"&&e!="popover"&&e in t)try{t[e]=r??"";break e}catch{}typeof r=="function"||(r==null||r===!1&&e[4]!="-"?t.removeAttribute(e):t.setAttribute(e,e=="popover"&&r==1?"":r))}}function De(t){return function(e){if(this.l){var r=this.l[e.type+t];if(e[ee]==null)e[ee]=ge++;else if(e[ee]<r[Q])return;return r(w.event?w.event(e):e)}}}function be(t,e,r,n,i,o,s,l,u,c){var _,a,g,p,v,C,f,h,y,$,q,m,E,L,z,b=e.type;if(e.constructor!==void 0)return null;128&r.__u&&(u=!!(32&r.__u),o=[l=e.__e=r.__e]),(_=w.__b)&&_(e);e:if(typeof b=="function")try{if(h=e.props,y=b.prototype&&b.prototype.render,$=(_=b.contextType)&&n[_.__c],q=_?$?$.props.value:_.__:n,r.__c?f=(a=e.__c=r.__c).__=a.__E:(y?e.__c=a=new b(h,q):(e.__c=a=new re(h,q),a.constructor=b,a.render=Et),$&&$.sub(a),a.state||(a.state={}),a.__n=n,g=a.__d=!0,a.__h=[],a._sb=[]),y&&a.__s==null&&(a.__s=a.state),y&&b.getDerivedStateFromProps!=null&&(a.__s==a.state&&(a.__s=H({},a.__s)),H(a.__s,b.getDerivedStateFromProps(h,a.__s))),p=a.props,v=a.state,a.__v=e,g)y&&b.getDerivedStateFromProps==null&&a.componentWillMount!=null&&a.componentWillMount(),y&&a.componentDidMount!=null&&a.__h.push(a.componentDidMount);else{if(y&&b.getDerivedStateFromProps==null&&h!==p&&a.componentWillReceiveProps!=null&&a.componentWillReceiveProps(h,q),e.__v==r.__v||!a.__e&&a.shouldComponentUpdate!=null&&a.shouldComponentUpdate(h,a.__s,q)===!1){e.__v!=r.__v&&(a.props=h,a.state=a.__s,a.__d=!1),e.__e=r.__e,e.__k=r.__k,e.__k.some(function(I){I&&(I.__=e)}),ie.push.apply(a.__h,a._sb),a._sb=[],a.__h.length&&s.push(a);break e}a.componentWillUpdate!=null&&a.componentWillUpdate(h,a.__s,q),y&&a.componentDidUpdate!=null&&a.__h.push(function(){a.componentDidUpdate(p,v,C)})}if(a.context=q,a.props=h,a.__P=t,a.__e=!1,m=w.__r,E=0,y)a.state=a.__s,a.__d=!1,m&&m(e),_=a.render(a.props,a.state,a.context),ie.push.apply(a.__h,a._sb),a._sb=[];else do a.__d=!1,m&&m(e),_=a.render(a.props,a.state,a.context),a.state=a.__s;while(a.__d&&++E<25);a.state=a.__s,a.getChildContext!=null&&(n=H(H({},n),a.getChildContext())),y&&!g&&a.getSnapshotBeforeUpdate!=null&&(C=a.getSnapshotBeforeUpdate(p,v)),L=_!=null&&_.type===M&&_.key==null?Qe(_.props.children):_,l=Ne(t,se(L)?L:[L],e,r,n,i,o,s,l,u,c),a.base=e.__e,e.__u&=-161,a.__h.length&&s.push(a),f&&(a.__E=a.__=null)}catch(I){if(e.__v=null,u||o!=null)if(I.then){for(e.__u|=u?160:128;l&&l.nodeType==8&&l.nextSibling;)l=l.nextSibling;o[o.indexOf(l)]=null,e.__e=l}else{for(z=o.length;z--;)he(o[z]);me(e)}else e.__e=r.__e,e.__k=r.__k,I.then||me(e);w.__e(I,e,r)}else o==null&&e.__v==r.__v?(e.__k=r.__k,e.__e=r.__e):l=e.__e=Tt(r.__e,e,r,n,i,o,s,u,c);return(_=w.diffed)&&_(e),128&e.__u?void 0:l}function me(t){t&&(t.__c&&(t.__c.__e=!0),t.__k&&t.__k.some(me))}function Ge(t,e,r){for(var n=0;n<r.length;n++)ye(r[n],r[++n],r[++n]);w.__c&&w.__c(e,t),t.some(function(i){try{t=i.__h,i.__h=[],t.some(function(o){o.call(i)})}catch(o){w.__e(o,i.__v)}})}function Qe(t){return typeof t!="object"||t==null||t.__b>0?t:se(t)?t.map(Qe):t.constructor!==void 0?null:H({},t)}function Tt(t,e,r,n,i,o,s,l,u){var c,_,a,g,p,v,C,f=r.props||ne,h=e.props,y=e.type;if(y=="svg"?i="http://www.w3.org/2000/svg":y=="math"?i="http://www.w3.org/1998/Math/MathML":i||(i="http://www.w3.org/1999/xhtml"),o!=null){for(c=0;c<o.length;c++)if((p=o[c])&&"setAttribute"in p==!!y&&(y?p.localName==y:p.nodeType==3)){t=p,o[c]=null;break}}if(t==null){if(y==null)return document.createTextNode(h);t=document.createElementNS(i,y,h.is&&h),l&&(w.__m&&w.__m(e,o),l=!1),o=null}if(y==null)f===h||l&&t.data==h||(t.data=h);else{if(o=y=="textarea"&&h.defaultValue!=null?null:o&&ae.call(t.childNodes),!l&&o!=null)for(f={},c=0;c<t.attributes.length;c++)f[(p=t.attributes[c]).name]=p.value;for(c in f)p=f[c],c=="dangerouslySetInnerHTML"?a=p:c=="children"||c in h||c=="value"&&"defaultValue"in h||c=="checked"&&"defaultChecked"in h||Z(t,c,null,p,i);for(c in h)p=h[c],c=="children"?g=p:c=="dangerouslySetInnerHTML"?_=p:c=="value"?v=p:c=="checked"?C=p:l&&typeof p!="function"||f[c]===p||Z(t,c,p,f[c],i);if(_)l||a&&(_.__html==a.__html||_.__html==t.innerHTML)||(t.innerHTML=_.__html),e.__k=[];else if(a&&(t.innerHTML=""),Ne(e.type=="template"?t.content:t,se(g)?g:[g],e,r,n,y=="foreignObject"?"http://www.w3.org/1999/xhtml":i,o,s,o?o[0]:r.__k&&F(r,0),l,u),o!=null)for(c=o.length;c--;)he(o[c]);l&&y!="textarea"||(c="value",y=="progress"&&v==null?t.removeAttribute("value"):v!=null&&(v!==t[c]||y=="progress"&&!v||y=="option"&&v!=f[c])&&Z(t,c,v,f[c],i),c="checked",C!=null&&C!=t[c]&&Z(t,c,C,f[c],i))}return t}function ye(t,e,r){try{if(typeof t=="function"){var n=typeof t.__u=="function";n&&t.__u(),n&&e==null||(t.__u=t(e))}else t.current=e}catch(i){w.__e(i,r)}}function Ve(t,e,r){var n,i;if(w.unmount&&w.unmount(t),(n=t.ref)&&(n.current&&n.current!=t.__e||ye(n,null,e)),(n=t.__c)!=null){if(n.componentWillUnmount)try{n.componentWillUnmount()}catch(o){w.__e(o,e)}n.base=n.__P=null}if(n=t.__k)for(i=0;i<n.length;i++)n[i]&&Ve(n[i],e,r||typeof t.type!="function");r||he(t.__e),t.__c=t.__=t.__e=void 0}function Et(t,e,r){return this.constructor(t,r)}function O(t,e,r){var n,i,o,s;e==document&&(e=document.documentElement),w.__&&w.__(t,e),i=(n=typeof r=="function")?null:r&&r.__k||e.__k,o=[],s=[],be(e,t=(!n&&r||e).__k=D(M,null,[t]),i||ne,ne,e.namespaceURI,!n&&r?[r]:i?null:e.firstChild?ae.call(e.childNodes):null,o,!n&&r?r:i?i.__e:e.firstChild,n,s),Ge(o,t,s)}ae=ie.slice,w={__e:function(t,e,r,n){for(var i,o,s;e=e.__;)if((i=e.__c)&&!i.__)try{if((o=i.constructor)&&o.getDerivedStateFromError!=null&&(i.setState(o.getDerivedStateFromError(t)),s=i.__d),i.componentDidCatch!=null&&(i.componentDidCatch(t,n||{}),s=i.__d),s)return i.__E=i}catch(l){t=l}throw t}},ze=0,wt=function(t){return t!=null&&t.constructor===void 0},re.prototype.setState=function(t,e){var r;r=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=H({},this.state),typeof t=="function"&&(t=t(H({},r),this.props)),t&&H(r,t),t!=null&&this.__v&&(e&&this._sb.push(e),Me(this))},re.prototype.forceUpdate=function(t){this.__v&&(this.__e=!0,t&&this.__h.push(t),Me(this))},re.prototype.render=M,j=[],He=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,Oe=function(t,e){return t.__v.__b-e.__v.__b},oe.__r=0,ue=Math.random().toString(8),ee="__d"+ue,Q="__a"+ue,je=/(PointerCapture)$|Capture$/i,ge=0,fe=De(!1),_e=De(!0),Ct=0;var V,S,ve,We,xe=0,rt=[],A=w,Ye=A.__b,Je=A.__r,Ke=A.diffed,Xe=A.__c,Ze=A.unmount,et=A.__;function Ce(t,e){A.__h&&A.__h(S,t,xe||e),xe=0;var r=S.__H||(S.__H={__:[],__h:[]});return t>=r.__.length&&r.__.push({}),r.__[t]}function R(t){return xe=1,Pt(ot,t)}function Pt(t,e,r){var n=Ce(V++,2);if(n.t=t,!n.__c&&(n.__=[r?r(e):ot(void 0,e),function(l){var u=n.__N?n.__N[0]:n.__[0],c=n.t(u,l);u!==c&&(n.__N=[c,n.__[1]],n.__c.setState({}))}],n.__c=S,!S.__f)){var i=function(l,u,c){if(!n.__c.__H)return!0;var _=n.__c.__H.__.filter(function(g){return g.__c});if(_.every(function(g){return!g.__N}))return!o||o.call(this,l,u,c);var a=n.__c.props!==l;return _.some(function(g){if(g.__N){var p=g.__[0];g.__=g.__N,g.__N=void 0,p!==g.__[0]&&(a=!0)}}),o&&o.call(this,l,u,c)||a};S.__f=!0;var o=S.shouldComponentUpdate,s=S.componentWillUpdate;S.componentWillUpdate=function(l,u,c){if(this.__e){var _=o;o=void 0,i(l,u,c),o=_}s&&s.call(this,l,u,c)},S.shouldComponentUpdate=i}return n.__N||n.__}function le(t,e){var r=Ce(V++,3);!A.__s&&it(r.__H,e)&&(r.__=t,r.u=e,S.__H.__h.push(r))}function nt(t,e){var r=Ce(V++,7);return it(r.__H,e)&&(r.__=t(),r.__H=e,r.__h=t),r.__}function $t(){for(var t;t=rt.shift();){var e=t.__H;if(t.__P&&e)try{e.__h.some(de),e.__h.some(we),e.__h=[]}catch(r){e.__h=[],A.__e(r,t.__v)}}}A.__b=function(t){S=null,Ye&&Ye(t)},A.__=function(t,e){t&&e.__k&&e.__k.__m&&(t.__m=e.__k.__m),et&&et(t,e)},A.__r=function(t){Je&&Je(t),V=0;var e=(S=t.__c).__H;e&&(ve===S?(e.__h=[],S.__h=[],e.__.some(function(r){r.__N&&(r.__=r.__N),r.u=r.__N=void 0})):(e.__h.some(de),e.__h.some(we),e.__h=[],V=0)),ve=S},A.diffed=function(t){Ke&&Ke(t);var e=t.__c;e&&e.__H&&(e.__H.__h.length&&(rt.push(e)!==1&&We===A.requestAnimationFrame||((We=A.requestAnimationFrame)||Lt)($t)),e.__H.__.some(function(r){r.u&&(r.__H=r.u),r.u=void 0})),ve=S=null},A.__c=function(t,e){e.some(function(r){try{r.__h.some(de),r.__h=r.__h.filter(function(n){return!n.__||we(n)})}catch(n){e.some(function(i){i.__h&&(i.__h=[])}),e=[],A.__e(n,r.__v)}}),Xe&&Xe(t,e)},A.unmount=function(t){Ze&&Ze(t);var e,r=t.__c;r&&r.__H&&(r.__H.__.some(function(n){try{de(n)}catch(i){e=i}}),r.__H=void 0,e&&A.__e(e,r.__v))};var tt=typeof requestAnimationFrame=="function";function Lt(t){var e,r=function(){clearTimeout(n),tt&&cancelAnimationFrame(e),setTimeout(t)},n=setTimeout(r,35);tt&&(e=requestAnimationFrame(r))}function de(t){var e=S,r=t.__c;typeof r=="function"&&(t.__c=void 0,r()),S=e}function we(t){var e=S;t.__c=t.__(),S=e}function it(t,e){return!t||t.length!==e.length||e.some(function(r,n){return r!==t[n]})}function ot(t,e){return typeof e=="function"?e(t):e}var Rt=0;function d(t,e,r,n,i,o){e||(e={});var s,l,u=e;if("ref"in u)for(l in u={},e)l=="ref"?s=e[l]:u[l]=e[l];var c={type:t,props:u,key:r,ref:s,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--Rt,__i:-1,__u:0,__source:i,__self:o};if(typeof t=="function"&&(s=t.defaultProps))for(l in s)u[l]===void 0&&(u[l]=s[l]);return w.vnode&&w.vnode(c),c}var qt=`
.pe-slider-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.4);
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
  color: #6b7280; padding: 0 4px; line-height: 1;
}
.pe-slider-body { overflow-y: auto; padding: 16px; flex: 1; }
.pe-gift-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (min-width: 480px) {
  .pe-gift-grid { grid-template-columns: repeat(3, 1fr); }
}
.pe-gift-card {
  border: 2px solid #e5e7eb; border-radius: 8px; padding: 12px 10px;
  cursor: pointer; transition: border-color .15s, box-shadow .15s; position: relative;
}
.pe-gift-card:hover:not(.pe-unavailable) { border-color: #111; }
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
.pe-slider-footer {
  padding: 14px 20px; border-top: 1px solid #f0f0f0;
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
}
.pe-selected-count { font-size: 13px; color: #6b7280; }
.pe-btn-confirm {
  background: #111; color: #fff; border: none; border-radius: 6px;
  padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background .15s; flex: 1;
}
.pe-btn-confirm:hover { background: #333; }
.pe-btn-confirm:disabled { background: #9ca3af; cursor: not-allowed; }
.pe-loading { display: flex; align-items: center; justify-content: center; padding: 40px; }
.pe-spinner {
  width: 28px; height: 28px; border: 3px solid #e5e7eb;
  border-top-color: #111; border-radius: 50%; animation: pe-spin .7s linear infinite;
}
@keyframes pe-spin { to { transform: rotate(360deg); } }
`;function Mt(){if(document.getElementById("pe-slider-styles"))return;let t=document.createElement("style");t.id="pe-slider-styles",t.textContent=qt,document.head.appendChild(t)}function Ut({payload:t,sessionId:e,onClose:r,onConfirm:n}){let[i,o]=R(new Set(t.selectableGifts.filter(p=>p.isSelected).map(p=>p.variantId))),[s,l]=R(!1),u=t.maxSelectableCount-t.alreadySelectedCount,c=i.size<u;function _(p){if(!p.isAvailable)return;let v=new Set(i);v.has(p.variantId)?v.delete(p.variantId):c&&v.add(p.variantId),o(v)}async function a(){l(!0);try{await n([...i]),T("promo_engine:gift_selected",{offer_id:t.offerId,variant_ids:[...i],session_id:e}),r()}finally{l(!1)}}function g(p){p.target.classList.contains("pe-slider-overlay")&&r()}return le(()=>{let p=v=>{v.key==="Escape"&&r()};return window.addEventListener("keydown",p),()=>window.removeEventListener("keydown",p)},[r]),d("div",{class:"pe-slider-overlay",onClick:g,role:"dialog","aria-modal":"true",children:d("div",{class:"pe-slider-modal",children:[d("div",{class:"pe-slider-header",children:[d("div",{children:[d("h2",{class:"pe-slider-title",children:t.title}),t.subtitle&&d("p",{class:"pe-slider-subtitle",children:t.subtitle})]}),d("button",{class:"pe-slider-close",onClick:r,"aria-label":"Close gift selection",children:"\u2715"})]}),d("div",{class:"pe-slider-body",children:d("div",{class:"pe-gift-grid",children:t.selectableGifts.map(p=>{let v=i.has(p.variantId),C=!p.isAvailable;return d("div",{class:`pe-gift-card${v?" pe-selected":""}${C?" pe-unavailable":""}`,onClick:()=>_(p),role:"checkbox","aria-checked":v,"aria-disabled":C,tabIndex:C?-1:0,onKeyDown:f=>{(f.key==="Enter"||f.key===" ")&&(f.preventDefault(),_(p))},children:[v&&d("span",{class:"pe-gift-check","aria-hidden":"true",children:"\u2713"}),p.imageUrl?d("img",{class:"pe-gift-img",src:p.imageUrl,alt:p.title,loading:"lazy",width:160,height:160}):d("div",{class:"pe-gift-img-placeholder","aria-hidden":"true"}),d("p",{class:"pe-gift-name",children:p.title}),p.variantTitle&&d("p",{class:"pe-gift-variant",children:p.variantTitle}),d("p",{class:"pe-gift-price",children:p.discountedPriceCents===0?d("span",{class:"pe-gift-free",children:"Free"}):d(M,{children:[d("s",{children:["$",(p.originalPriceCents/100).toFixed(2)]})," ",d("span",{class:"pe-gift-free",children:["$",(p.discountedPriceCents/100).toFixed(2)]})]})}),C&&d("p",{style:{fontSize:"11px",color:"#ef4444",marginTop:"4px"},children:"Out of stock"})]},p.variantId)})})}),d("div",{class:"pe-slider-footer",children:[d("p",{class:"pe-selected-count",children:[i.size," / ",u," selected"]}),d("button",{class:"pe-btn-confirm",onClick:a,disabled:i.size===0||s,children:s?d("span",{class:"pe-spinner",style:{display:"inline-block"}}):`Add ${i.size>0?i.size:""} Gift${i.size!==1?"s":""} to Cart`})]})]})})}var B=null;function at(t,e){Mt(),B||(B=document.createElement("div"),B.id="pe-gift-slider-root",document.body.appendChild(B)),O(D(Ut,{payload:t,sessionId:e,onClose:()=>{B&&(O(D(M,null),B),P(x.GiftSliderClosed),T("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e}))},onConfirm:async i=>{let s=(await U.getCart()).items.filter(l=>l.properties._promo_engine_offer_id===t.offerId);for(let l of s)i.includes(String(l.variant_id))||await U.removeLine({key:l.key});for(let l of i)if(!s.some(c=>String(c.variant_id)===l)){let c=t.selectableGifts.find(_=>_.variantId===l);await U.addLines([{variantId:l,quantity:1,properties:{_promo_engine_line_type:"gift",_promo_engine_offer_id:t.offerId,_promo_engine_reward_id:c?.variantId??l,_promo_engine_offer_version:"1",_promo_engine_hash:""}}])}P(x.CartChanged)}}),B),T("promo_engine:gift_slider_opened",{offer_id:t.offerId,session_id:e})}function st(t){k(x.EvaluationCompleted,e=>{e.giftSlider&&Array.isArray(e.giftSlider.selectableGifts)&&at(e.giftSlider,t)}),k(x.GiftSliderRequested,e=>{at(e,t)})}var Dt=`
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
`;function W(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function zt({config:t,currency:e,sessionId:r}){let[n,i]=R(new Set([t.mainProduct.variantId,...t.relatedProducts.slice(0,2).map(f=>f.variantId)])),[o,s]=R(!1),[l,u]=R(!1),c=[t.mainProduct,...t.relatedProducts.slice(0,t.maxProducts-1)],_=c.filter(f=>n.has(f.variantId)),a=_.reduce((f,h)=>f+h.discountedPriceCents,0),p=_.reduce((f,h)=>f+h.priceCents,0)-a;function v(f){if(f===t.mainProduct.variantId)return;let h=new Set(n);h.has(f)?h.delete(f):h.add(f),i(h)}async function C(){if(!(o||_.length===0)){s(!0);try{await U.addLines(_.map(f=>({variantId:f.variantId,quantity:1,properties:{_promo_engine_line_type:"upsell",_promo_engine_offer_id:t.offerId}}))),u(!0),P(x.CartChanged),T("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,widget_type:"fbt",variant_ids:[...n],session_id:r})}finally{s(!1)}}}return le(()=>{T("promo_engine:widget_viewed",{offer_id:t.offerId,widget_type:"fbt",session_id:r})},[]),l?d("div",{class:"pe-fbt",children:d("p",{class:"pe-fbt-added",children:["\u2713 Added ",_.length," item(s) to cart!"]})}):d("div",{class:"pe-fbt",children:[d("h3",{class:"pe-fbt-title",children:t.title||"Frequently Bought Together"}),d("div",{class:"pe-fbt-products",children:c.map((f,h)=>{let y=n.has(f.variantId),$=f.variantId===t.mainProduct.variantId;return d(M,{children:[h>0&&d("span",{class:"pe-fbt-plus","aria-hidden":"true",children:"+"}),d("div",{class:`pe-fbt-product${y?" pe-selected":""}`,onClick:()=>v(f.variantId),role:"checkbox","aria-checked":y,tabIndex:$?-1:0,onKeyDown:q=>{(q.key===" "||q.key==="Enter")&&(q.preventDefault(),v(f.variantId))},children:[d("input",{type:"checkbox",class:"pe-fbt-check",checked:y,disabled:$,"aria-hidden":"true",tabIndex:-1,readOnly:!0}),f.imageUrl?d("img",{class:"pe-fbt-img",src:f.imageUrl,alt:f.title,loading:"lazy"}):d("div",{class:"pe-fbt-img-ph","aria-hidden":"true"}),d("div",{class:"pe-fbt-info",children:[d("p",{class:"pe-fbt-name",children:f.title}),f.variantTitle&&d("p",{class:"pe-fbt-price",children:f.variantTitle}),d("p",{class:"pe-fbt-price",children:f.discountedPriceCents<f.priceCents?d("span",{class:"pe-fbt-price-disc",children:W(f.discountedPriceCents,e)}):W(f.priceCents,e)})]})]},f.variantId)]})})}),d("div",{class:"pe-fbt-summary",children:[d("p",{class:"pe-fbt-total",children:["Total: ",d("strong",{children:W(a,e)}),p>0&&d(M,{children:[" ",d("span",{class:"pe-fbt-price-disc",children:["(save ",W(p,e),")"]})]})]}),d("button",{class:"pe-fbt-btn",onClick:C,disabled:o||_.length===0,"aria-label":`Add ${_.length} item(s) to cart for ${W(a,e)}`,children:o?"Adding\u2026":t.buttonText||`Add ${_.length} to Cart`})]})]})}function dt(t,e,r,n){if(!document.getElementById("pe-fbt-styles")){let i=document.createElement("style");i.id="pe-fbt-styles",i.textContent=Dt,document.head.appendChild(i)}O(D(zt,{config:e,currency:r,sessionId:n}),t)}var Ht={position:"bottom_right",style:"icon_title",primaryColor:"#111",iconSizeRem:3.5},Ot=`
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
`;function jt({items:t,config:e,sessionId:r}){let[n,i]=R(!1);if(t.length===0)return null;let o=e.position==="bottom_left"?"pe-left":"pe-right";function s(l){if(T("promo_engine:widget_clicked",{offer_id:l.offerId,widget_type:"today_offer",session_id:r}),l.redirectUrl)try{let u=new URL(l.redirectUrl,window.location.href);if(u.protocol==="http:"||u.protocol==="https:"){window.location.href=u.href;return}}catch{}i(!1)}return d("div",{class:`pe-today-wrap ${o}`,style:{"--pe-primary":e.primaryColor},children:[n&&d("div",{class:"pe-today-panel",role:"dialog","aria-label":"Today's offers",children:[d("div",{class:"pe-today-panel-header",children:[d("h3",{class:"pe-today-panel-title",children:"Today's Offers"}),d("button",{class:"pe-today-close",onClick:()=>i(!1),"aria-label":"Close",children:"\u2715"})]}),d("div",{class:"pe-today-offers",children:t.map(l=>d("div",{class:"pe-today-offer-item",onClick:()=>s(l),role:"button",tabIndex:0,onKeyDown:u=>{u.key==="Enter"&&s(l)},children:[l.imageUrl?d("img",{class:"pe-today-offer-img",src:l.imageUrl,alt:l.title,loading:"lazy"}):d("div",{class:"pe-today-offer-img","aria-hidden":"true",children:"\u{1F381}"}),d("div",{class:"pe-today-offer-info",children:[d("p",{class:"pe-today-offer-title",children:l.title}),l.description&&d("p",{class:"pe-today-offer-desc",children:l.description})]}),d("span",{class:"pe-today-offer-btn",children:l.buttonText||"View \u2192"})]},l.offerId))})]}),d("button",{class:"pe-today-trigger",onClick:()=>{i(l=>!l),n||T("promo_engine:widget_viewed",{widget_type:"today_offer",offer_count:t.length,session_id:r})},"aria-expanded":n,"aria-haspopup":"dialog","aria-label":`${t.length} offer${t.length!==1?"s":""} available`,children:[d("span",{class:"pe-today-icon","aria-hidden":"true",children:"\u{1F381}"}),e.style==="icon_title"&&d("span",{children:"Today's Deals"}),d("span",{class:"pe-today-dot","aria-hidden":"true"})]})]})}var Y=null;function lt(t,e){let r={...Ht,...t};if(!document.getElementById("pe-today-styles")){let n=document.createElement("style");n.id="pe-today-styles",n.textContent=Ot,document.head.appendChild(n)}Y||(Y=document.createElement("div"),Y.id="pe-today-offer-root",document.body.appendChild(Y)),k(x.EvaluationCompleted,n=>{let i=(Array.isArray(n.qualifiedOffers)?n.qualifiedOffers:[]).map(o=>({offerId:o.offerId,title:o.type+" offer",description:"",imageUrl:null,buttonText:"View",redirectUrl:null,badgeText:null}));O(D(jt,{items:i,config:r,sessionId:e}),Y)})}function ct(t,e){return new Intl.NumberFormat(navigator.language,{style:"currency",currency:e}).format(t/100)}function Bt(t,e){return[...e].sort((r,n)=>n.minQuantity-r.minQuantity).find(r=>t>=r.minQuantity)??null}function Nt({config:t,sessionId:e}){let[r,n]=R(0),[i,o]=R(new Map),[s,l]=R(""),u="name_asc",[c,_]=R(!1),[a,g]=R(!1),p=t.layoutMode==="one_step_per_page",v=p?[t.steps[r]].filter(Boolean):t.steps,C=nt(()=>{let m=0;for(let E of i.values())for(let L of E.values())m+=L;return m},[i]),f=Bt(C,t.tiers);function h(m,E,L){o(z=>{let b=new Map(z),I=new Map(b.get(m)??[]);return L===0?I.delete(E):I.set(E,L),b.set(m,I),b})}function y(m){return[...i.get(m)?.values()??[]].reduce((E,L)=>E+L,0)}function $(m){let E=y(m.id);return E>=m.minQuantity&&(m.maxQuantity===null||E<=m.maxQuantity)}async function q(){if(!c){_(!0);try{let m=[];for(let[E,L]of i.entries())for(let[z,b]of L.entries())m.push({variantId:z,quantity:b,properties:{_promo_engine_line_type:"bundle_component",_promo_engine_offer_id:t.offerId,_promo_engine_bundle_id:t.bundleId,_promo_engine_bundle_step_id:E,_promo_engine_bundle_title:t.title,_promo_engine_hash:""}});await U.addLines(m),g(!0),P(x.CartChanged),T("promo_engine:bundle_added_to_cart",{offer_id:t.offerId,bundle_id:t.bundleId,total_qty:C,session_id:e})}finally{_(!1)}}}return a?d("div",{class:"pe-bb-success",children:[d("p",{children:"\u2713 Bundle added to cart!"}),d("button",{onClick:()=>g(!1),children:"Build Another"})]}):d("div",{class:"pe-bb",children:[d("h1",{class:"pe-bb-title",children:t.title}),t.description&&d("p",{class:"pe-bb-desc",children:t.description}),t.tiers.length>0&&d("div",{class:"pe-bb-tiers",children:t.tiers.map(m=>d("div",{class:`pe-bb-tier${f?.minQuantity===m.minQuantity?" pe-active":""}`,children:[d("span",{class:"pe-bb-tier-label",children:m.label}),d("span",{class:"pe-bb-tier-qty",children:["Buy ",m.minQuantity,"+"]}),d("span",{class:"pe-bb-tier-discount",children:m.discountType==="percentage"?`-${Math.round(m.discountValue)}%`:ct(m.discountValue,t.currency)})]},m.minQuantity))}),v.map(m=>{let E=y(m.id),L=$(m),z=m.products.filter(b=>!s||b.title.toLowerCase().includes(s.toLowerCase())).sort((b,I)=>u==="price_asc"?b.priceCents-I.priceCents:u==="price_desc"?I.priceCents-b.priceCents:b.title.localeCompare(I.title));return d("div",{class:"pe-bb-step",children:[d("div",{class:"pe-bb-step-header",children:[d("h2",{class:"pe-bb-step-title",children:[p&&`Step ${r+1} of ${t.steps.length}: `,m.title]}),m.subtitle&&d("p",{class:"pe-bb-step-subtitle",children:m.subtitle}),d("p",{class:"pe-bb-step-count",children:[E," selected",m.minQuantity>0&&` (min ${m.minQuantity})`,m.maxQuantity&&` (max ${m.maxQuantity})`,L&&" \u2713"]})]}),m.searchEnabled&&d("input",{class:"pe-bb-search",type:"text",placeholder:"Search products...",value:s,onInput:b=>l(b.target.value),"aria-label":"Search products in this step"}),d("div",{class:"pe-bb-products",children:z.map(b=>{let I=i.get(m.id)?.get(b.variantId)??0,Pe=m.maxQuantity!==null&&E>=m.maxQuantity&&I===0;return d("div",{class:`pe-bb-product${I>0?" pe-selected":""}${b.isAvailable?"":" pe-unavailable"}${Pe?" pe-at-max":""}`,children:[b.imageUrl&&d("img",{class:"pe-bb-img",src:b.imageUrl,alt:b.title,loading:"lazy"}),d("p",{class:"pe-bb-product-name",children:b.title}),b.variantTitle&&d("p",{class:"pe-bb-variant",children:b.variantTitle}),d("p",{class:"pe-bb-price",children:ct(b.priceCents,t.currency)}),b.isAvailable?d("div",{class:"pe-bb-qty-ctrl",children:[d("button",{onClick:()=>h(m.id,b.variantId,Math.max(0,I-1)),disabled:I===0,"aria-label":`Remove ${b.title}`,children:"\u2212"}),d("span",{class:"pe-bb-qty",children:I}),d("button",{onClick:()=>h(m.id,b.variantId,I+1),disabled:Pe,"aria-label":`Add ${b.title}`,children:"+"})]}):d("span",{class:"pe-bb-oos",children:"Out of stock"})]},b.variantId)})})]},m.id)}),d("div",{class:"pe-bb-footer",children:p?d("div",{class:"pe-bb-nav",children:[r>0&&d("button",{class:"pe-bb-btn-prev",onClick:()=>n(m=>m-1),children:"\u2190 Previous"}),r<t.steps.length-1?d("button",{class:"pe-bb-btn-next",onClick:()=>{T("promo_engine:bundle_step_completed",{offer_id:t.offerId,step_index:r,session_id:e}),n(m=>m+1)},disabled:!t.steps[r]||!$(t.steps[r]),children:"Next \u2192"}):d("button",{class:"pe-bb-btn-add",onClick:q,disabled:c||!t.steps.every(m=>$(m)),children:c?"Adding\u2026":`Add Bundle to Cart${f?` (${f.label})`:""}`})]}):d("div",{class:"pe-bb-summary",children:[d("p",{class:"pe-bb-total",children:[C," items selected"]}),f&&d("p",{class:"pe-bb-saving",children:["\u{1F4B0} ",f.label," applied!"]}),d("button",{class:"pe-bb-btn-add",onClick:q,disabled:c||!t.steps.every(m=>$(m)),children:c?"Adding\u2026":"Add Bundle to Cart"})]})})]})}function pt(t,e,r){O(D(Nt,{config:e,sessionId:r}),t)}var Ie=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.renderSkeleton(),this.unsubscribe=k(x.EvaluationCompleted,e=>{let r=(Array.isArray(e.progressBars)?e.progressBars:[]).find(n=>n.offerId===this.offerId||n.widgetId===this.widgetId);r&&this.renderPayload(r)})}disconnectedCallback(){this.unsubscribe?.()}renderSkeleton(){this.shadowRoot&&(this.shadowRoot.innerHTML=`
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
    `)}renderPayload(e){if(!this.shadowRoot)return;let r=this.shadowRoot.querySelector(".pe-pb-wrap"),n=this.shadowRoot.querySelector(".pe-pb-msg"),i=this.shadowRoot.querySelector(".pe-pb-fill");if(!r||!n||!i)return;let o=Math.min(100,Math.round(e.progressPercent)),s=e.isGoalReached?e.messageAfterGoal:e.messageBeforeGoal;n.textContent=this.interpolateMessage(s,e),i.style.width=`${o}%`,i.classList.toggle("pe-goal",e.isGoalReached),r.setAttribute("aria-valuenow",String(o)),this.setAttribute("aria-label",`Progress: ${o}%`)}interpolateMessage(e,r){let n=r.targetCents-r.currentCents,i=(r.targetQuantity??0)-r.currentQuantity,o=this.getAttribute("currency")??"USD",s=l=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:o}).format(l/100);return e.replace("{{remaining_amount}}",s(Math.max(0,n))).replace("{{remaining_quantity}}",String(Math.max(0,i))).replace("{{current_amount}}",s(r.currentCents)).replace("{{target_amount}}",s(r.targetCents))}};customElements.define("promo-progress-bar",Ie);var ke=class extends HTMLElement{offerId="";widgetId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.widgetId=this.getAttribute("widget-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(x.EvaluationCompleted,e=>{let r=(Array.isArray(e.cartMessages)?e.cartMessages:[]).filter(n=>n.offerId===this.offerId||n.widgetId===this.widgetId).sort((n,i)=>n.priority-i.priority);this.render(r[0]??null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e){this.shadowRoot.innerHTML="<style>:host { display: none; }</style>";return}let n={progress:"#f59e0b",success:"#059669",info:"#3b82f6"}[e.type]??"#111",i=this.sanitize(e.message);this.shadowRoot.innerHTML=`
      <style>
        :host { display: block; }
        .pe-msg {
          padding: 10px 14px;
          border-left: 3px solid ${n};
          background: ${n}18;
          border-radius: 0 6px 6px 0;
          font-size: 13px;
          line-height: 1.5;
          color: inherit;
        }
      </style>
      <div class="pe-msg" role="status" aria-live="polite">${i}</div>
    `}sanitize(e){let r=document.createElement("div");return r.textContent=e,r.innerHTML}};customElements.define("promo-cart-message",ke);function ce(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function Ft(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var Gt=`
:host { display: inline-block; }
.pe-gift-icon-wrap {
  display: inline-flex; align-items: center; gap: 6px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 999px;
  padding: 4px 12px; font-size: 13px; font-weight: 600; color: #059669;
  cursor: pointer; transition: background .15s;
}
.pe-gift-icon-wrap:hover { background: #dcfce7; }
.pe-gift-icon-wrap.pe-hidden { display: none; }
.pe-gift-emoji { font-size: 15px; }
`,Se=class extends HTMLElement{offerId="";variantId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(x.EvaluationCompleted,e=>{let r=Array.isArray(e.qualifiedOffers)?e.qualifiedOffers.find(n=>n.offerId===this.offerId):null;this.render(r?{offerName:"Free Gift Available"}:null)}),k(x.ProductChanged,e=>{this.variantId=e.variantId})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let r=ce(this.getAttribute("label")??"Free Gift"),n=parseInt(this.getAttribute("countdown-seconds")??"0",10),i=ce(e?.offerName??""),o=ce(this.offerId);this.shadowRoot.innerHTML=`
      <style>${Gt}</style>
      <div class="pe-gift-icon-wrap${e?"":" pe-hidden"}"
           role="button" tabindex="0"
           aria-label="View free gift offer"
           title="${i}">
        <span class="pe-gift-emoji" aria-hidden="true">\u{1F381}</span>
        <span>${r}</span>
        ${n>0?`<span class="pe-countdown" id="cd-${o}"></span>`:""}
      </div>
    `,e&&(this.shadowRoot.querySelector(".pe-gift-icon-wrap")?.addEventListener("click",()=>{P(x.GiftSliderRequested,{offerId:this.offerId}),T("promo_engine:widget_clicked",{offer_id:this.offerId,widget_type:"gift_icon"})}),n>0&&this.startCountdown(n))}startCountdown(e){if(!this.shadowRoot)return;let r=e,n=()=>{let i=this.shadowRoot?.getElementById(`cd-${this.offerId}`);if(!i)return;let o=Math.floor(r/60),s=r%60;i.textContent=` (${o}:${String(s).padStart(2,"0")})`,r--,r>=0&&setTimeout(n,1e3)};n()}};customElements.define("promo-gift-icon",Se);var ut=`
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
.pe-thumb-cta { margin-top: 8px; font-size: 12px; color: #111; font-weight: 600; cursor: pointer; text-decoration: underline; }
`,Ae=class extends HTMLElement{offerId="";unsubscribe=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.attachShadow({mode:"open"}),this.render(null),this.unsubscribe=k(x.EvaluationCompleted,e=>{let r=Array.isArray(e.qualifiedOffers)?e.qualifiedOffers.find(i=>i.offerId===this.offerId):null,n=e.giftSlider;this.render(r&&n?n.selectableGifts:null)})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;if(!e||e.length===0){this.shadowRoot.innerHTML=`<style>${ut}</style><div class="pe-thumb-wrap pe-hidden"></div>`;return}let n=e.slice(0,4).map(i=>{let o=Ft(i.imageUrl),s=ce(i.title);return o?`<div class="pe-thumb-product">
               <img class="pe-thumb-img" src="${o}" alt="${s}" loading="lazy"/>
               <span class="pe-thumb-name">${s}</span>
             </div>`:`<div class="pe-thumb-product">
               <div class="pe-thumb-img-ph" aria-hidden="true">\u{1F381}</div>
               <span class="pe-thumb-name">${s}</span>
             </div>`}).join("");this.shadowRoot.innerHTML=`
      <style>${ut}</style>
      <div class="pe-thumb-wrap">
        <p class="pe-thumb-offer-name">\u{1F381} Free Gift</p>
        <div class="pe-thumb-products">${n}</div>
        ${e.length>4?`<p class="pe-thumb-count">+${e.length-4} more gifts available</p>`:""}
        <p class="pe-thumb-cta" role="button" tabindex="0">Choose your gift \u2192</p>
      </div>
    `,this.shadowRoot.querySelector(".pe-thumb-cta")?.addEventListener("click",()=>{P(x.GiftSliderRequested,{offerId:this.offerId})})}};customElements.define("promo-gift-thumbnail",Ae);var Qt=`
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
`,Te=class extends HTMLElement{offerId="";variantId="";currency="USD";unsubscribeVariant=null;connectedCallback(){this.offerId=this.getAttribute("offer-id")??"",this.variantId=this.getAttribute("variant-id")??"",this.currency=this.getAttribute("currency")??"USD",this.attachShadow({mode:"open"}),this.loadAndRender(),this.unsubscribeVariant=k(x.ProductChanged,e=>{this.variantId=e.variantId,this.setAttribute("variant-id",e.variantId),this.loadAndRender()})}disconnectedCallback(){this.unsubscribeVariant?.()}async loadAndRender(){if(!(!this.offerId||!this.variantId)&&this.shadowRoot)try{let e=window.Shopify?.shop??location.hostname,r=await fetch(`/apps/promo-engine/product-customizations?offer_id=${encodeURIComponent(this.offerId)}&variant_id=${encodeURIComponent(this.variantId)}`,{headers:{"X-Promo-Shop":e}});if(!r.ok){this.renderEmpty();return}let n=await r.json();n.volumeDiscount?this.renderTiers(n.volumeDiscount):this.renderEmpty()}catch{this.renderEmpty()}}renderTiers(e){if(!this.shadowRoot)return;let r=i=>new Intl.NumberFormat(navigator.language,{style:"currency",currency:e.currency}).format(i/100),n=e.tiers.map((i,o)=>`
        <div class="pe-vd-tier ${o===0?"pe-active":""}"
             data-qty="${i.minQuantity}"
             role="button"
             tabindex="0"
             aria-label="Buy ${i.minQuantity}+ for ${r(i.discountedPriceCents)} each">
          <div>
            <p class="pe-vd-qty">${i.minQuantity===1?"1 item":`${i.minQuantity}+ items`}</p>
          </div>
          <span class="pe-vd-label">${i.label||(i.discountType==="percentage"?`-${Math.round(i.discountValue)}%`:"Deal")}</span>
          <div class="pe-vd-price">
            ${i.originalPriceCents!==i.discountedPriceCents?`<p class="pe-vd-price-original">${r(i.originalPriceCents)}</p>`:""}
            <p class="pe-vd-price-discounted">${r(i.discountedPriceCents)} each</p>
          </div>
        </div>`).join("");this.shadowRoot.innerHTML=`
      <style>${Qt}</style>
      <div class="pe-vd-wrap">
        <div class="pe-vd-title">Volume Discounts</div>
        ${n}
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-vd-tier").forEach(i=>{i.addEventListener("click",()=>{let o=parseInt(i.dataset.qty??"1",10),s=document.querySelector('input[name="quantity"]');s&&(s.value=String(o),s.dispatchEvent(new Event("change",{bubbles:!0}))),this.shadowRoot?.querySelectorAll(".pe-vd-tier").forEach(l=>l.classList.remove("pe-active")),i.classList.add("pe-active")})})}renderEmpty(){this.shadowRoot&&(this.shadowRoot.innerHTML="<style>:host { display: none; }</style>")}};customElements.define("promo-volume-discount",Te);function J(t){let e=document.createElement("div");return e.textContent=String(t??""),e.innerHTML}function Vt(t){if(typeof t!="string"||!t)return null;try{let e=new URL(t,window.location.href);return e.protocol==="http:"||e.protocol==="https:"?e.href:null}catch{return null}}var ft=`
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
`,Ee=class extends HTMLElement{filterOfferIds=[];unsubscribe=null;connectedCallback(){let e=this.getAttribute("offer-ids");this.filterOfferIds=e?e.split(",").map(r=>r.trim()):[],this.attachShadow({mode:"open"}),this.render([]),this.unsubscribe=k(x.EvaluationCompleted,r=>{let n=Array.isArray(r.qualifiedOffers)?r.qualifiedOffers:[];this.filterOfferIds.length>0&&(n=n.filter(i=>this.filterOfferIds.includes(i.offerId))),this.render(n.map(i=>({offerId:i.offerId,title:i.type,description:"",imageUrl:null,badgeText:"Active"})))})}disconnectedCallback(){this.unsubscribe?.()}render(e){if(!this.shadowRoot)return;let r=J(this.getAttribute("title")??"Today's Offers");if(e.length===0){this.shadowRoot.innerHTML=`<style>${ft}</style><div class="pe-tob-empty"></div>`;return}let n=e.map(i=>{let o=J(i.offerId),s=J(i.title),l=J(i.description),u=J(i.badgeText),c=Vt(i.imageUrl);return`
      <div class="pe-tob-item" data-offer="${o}" role="button" tabindex="0">
        ${c?`<img class="pe-tob-img" src="${c}" alt="${s}" loading="lazy">`:'<div class="pe-tob-img" aria-hidden="true">\u{1F381}</div>'}
        <div class="pe-tob-info">
          <p class="pe-tob-title">${s}</p>
          ${l?`<p class="pe-tob-desc">${l}</p>`:""}
        </div>
        <span class="pe-tob-badge">${u}</span>
      </div>
    `}).join("");this.shadowRoot.innerHTML=`
      <style>${ft}</style>
      <div class="pe-tob-wrap">
        <div class="pe-tob-header">${r}</div>
        <div class="pe-tob-items">${n}</div>
      </div>
    `,this.shadowRoot.querySelectorAll(".pe-tob-item").forEach(i=>{let o=i.dataset.offer??"";i.addEventListener("click",()=>{T("promo_engine:widget_clicked",{offer_id:o,widget_type:"today_offer_block"})})})}};customElements.define("promo-today-offer-block",Ee);return yt(Wt);})();
