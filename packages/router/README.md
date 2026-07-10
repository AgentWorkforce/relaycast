Route precedence:

- `/cloud*` routes to the Agent Relay Cloud Next.js app.
- `/observer/file*` routes to the RelayFile observer app, expected to be built with `basePath: "/observer/file"`.
- `/observer*` routes to the Relaycast observer app.
- everything else falls back to the legacy proxy target.

RelayFile observer deployment is wired from the production job in
`.github/workflows/deploy.yml`. The job runs
`scripts/deploy-file-observer-pages.sh`, which packs
`@relayfile/file-observer@latest`, builds it with
`FILE_OBSERVER_BASE_PATH=/observer/file`, and deploys the detected static output
to the Cloudflare Pages project `relayfile-file-observer`. The script creates
that Pages project with the configured production branch when it is missing, so
the first production deploy does not require manual Cloudflare setup.

```
                                     ┌────────────────────────────────────┐                                        
                                     │       @agentworkforce/cloud        │                                        
                                     │                                    │                                        
                                     │/packages/router (Cloudflare worker)│                                        
                                     └────────────────────────────────────┘                                        
                                                                                                                   
                                    ┌──────────────────────────────────────┐                                       
                                    │            agentrelay.com            │                                       
                                    └──────────────────────────────────────┘                                       
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                          All cloud routes              │          Observer Routes                                 
                   ┌───(/cloud/*, /cloud/api)───────────┼────(/observer*, /observer/file*)───────┐
                   │                                    │                                       │                  
                   │                                    │                                       │                  
                   │                                    │                                       │                  
                   ▼                                    │                                       ▼                  
┌────────────────────────────────────┐                  │                    ┌────────────────────────────────────┐
│      https://agentrelay.com      │                  │                    │   https://relaycast.dev/observer   │
└────────────────────────────────────┘                  │                    └────────────────────────────────────┘
                                                        │                                                          
                                                        │                                                          
┌────────────────────────────────────┐            All Other Routes           ┌────────────────────────────────────┐
│       @agentworkforce/cloud        │      (/, /docs, /blog, /openclaw)     │     @agentworkforce/relaycast      │
│                                    │                  │                    │                                    │
│     /packages/web (NextJs App)     │                  │                    │ /packages/observer-dashboard       │
│                                    │                  │                    │ /@relayfile/file-observer          │
└────────────────────────────────────┘                  │                    └────────────────────────────────────┘
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        │                                                          
                                                        ▼                                                          
                                     ┌────────────────────────────────────┐                                        
                                     │  https://origin-web.agentrelay.com │                                        
                                     └────────────────────────────────────┘                                        
                                                                                                                   
                                                                                                                   
                                     ┌────────────────────────────────────┐                                        
                                     │       @agentworkforce/relay        │                                        
                                     │                                    │                                        
                                     │         /web (NextJs App)          │                                        
                                     └────────────────────────────────────┘                                        
```
