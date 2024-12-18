import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the "public" directory
app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// EventSource connection for logs
app.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Push logs dynamically
    const log = (message) => {
        res.write(`data: ${message}\n\n`);
    };

    // Trigger the main function
    scanAndUpdateProducts(log)
        .then(() => {
            log("Finished drafting products.");
            // Signal the client to close the connection
            res.write("event: CLOSE\ndata: Connection closed\n\n");
            res.end();
        })
        .catch((error) => {
            log(`Error: ${error.message}`);
            res.write("event: CLOSE\ndata: Connection closed\n\n");
            res.end();
        });
});

// Main function
async function scanAndUpdateProducts(log) {
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    const shopifyStore = process.env.SHOPIFY_STORE;

    const headers = {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
    };

    let hasMoreProducts = true;
    let cursor = null;

    try {
        while (hasMoreProducts) {
            const query = `
                query ($cursor: String) {
                    products(first: 100, after: $cursor) {
                        edges {
                            cursor
                            node {
                                id
                                title
                                status
                                variants(first: 10) {
                                    edges {
                                        node {
                                            inventoryQuantity
                                            inventoryPolicy
                                        }
                                    }
                                }
                            }
                        }
                        pageInfo {
                            hasNextPage
                        }
                    }
                }
            `;

            const response = await fetch(`https://${shopifyStore}/admin/api/2024-01/graphql.json`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query, variables: { cursor } }),
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch products: ${response.statusText}`);
            }

            const result = await response.json();
            const products = result.data.products.edges;
            hasMoreProducts = result.data.products.pageInfo.hasNextPage;
            cursor = hasMoreProducts ? products[products.length - 1].cursor : null;

            for (const product of products) {
                const productId = product.node.id;
                const productStatus = product.node.status;
                const variants = product.node.variants.edges;

                // Skip products that are already drafted
                if (productStatus === "DRAFT") {
                    log(`Product "${product.node.title}" is already drafted. Skipping...`);
                    continue;
                }

                const trackedVariants = variants.filter(
                    variant => variant.node.inventoryPolicy !== "NOT_TRACKED"
                );

                if (trackedVariants.length === 0) {
                    log(`Product "${product.node.title}" has no tracked inventory. Skipping...`);
                    continue;
                }

                const allOutOfStock = trackedVariants.every(variant => variant.node.inventoryQuantity <= 0);

                if (allOutOfStock) {
                    log(`Product "${product.node.title}" is out of stock. Drafting...`);

                    const mutation = `
                        mutation {
                            productUpdate(input: { id: "${productId}", status: DRAFT }) {
                                product {
                                    id
                                    status
                                }
                                userErrors {
                                    field
                                    message
                                }
                            }
                        }
                    `;

                    const updateResponse = await fetch(`https://${shopifyStore}/admin/api/2024-01/graphql.json`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ query: mutation }),
                    });

                    const updateResult = await updateResponse.json();

                    if (updateResult.data.productUpdate.userErrors.length > 0) {
                        log(`Error drafting product "${product.node.title}": ${JSON.stringify(updateResult.data.productUpdate.userErrors)}`);
                    } else {
                        log(`Product "${product.node.title}" has been drafted.`);
                    }
                } else {
                    log(`Product "${product.node.title}" has inventory in stock. Skipping...`);
                }
            }
        }
    } catch (error) {
        log(`Error: ${error.message}`);
    }
}

// Start the server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});