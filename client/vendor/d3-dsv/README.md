# Pinned CSV parser

`src/csv.js` and `src/dsv.js` originate from `d3-dsv` 3.0.1, whose official npm tarball has SHA-512 integrity `sha512-UG6OvdI5afDIFP9w4G0mNq50dSOsXHJaRE8arAS5o9ApWnIElp8GZw1Dun8vP8OyHOZ/QJUKUJwxiiCCnUwm+Q==`. The accompanying ISC `LICENSE` is retained. The only local source patch replaces the upstream `new Function` object converter with an ordinary closure and a null-prototype object. The import boundary calls only `csvParseRows`; a separate strict scanner enforces the product's grammar and limits before invoking it. No file content is interpreted as executable code.
