docker run --rm -i yousan/swagger-yaml-to-html < openapi.yaml > app/templates/pages/index.html
awk 'NR==6{print "  <meta name=\"robots\" content=\"none\" />"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
awk 'NR==7{print "  <meta name=\"googlebot\" content=\"none\" />"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
sed -i '8d' app/templates/pages/index.html
awk 'NR==8{print "  <title>Cakradana Core API - Swagger UI</title>"}1' app/templates/pages/index.html > temp.html && mv temp.html app/templates/pages/index.html
