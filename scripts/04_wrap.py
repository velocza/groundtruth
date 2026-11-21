"""Wrap site/page.html (artifact body form) into a standalone site/index.html."""
import sys
p=open(sys.argv[1]+'/page.html').read()
head='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
open(sys.argv[1]+'/index.html','w').write(head+p+'</body></html>')
